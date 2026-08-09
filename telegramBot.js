const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { Upload } = require('@aws-sdk/lib-storage');
const { Telegraf } = require('telegraf');

// Wires a Telegram bot into the same room storage the website uses. Only
// starts if TELEGRAM_BOT_TOKEN and TELEGRAM_LOCAL_API_URL are both set —
// otherwise the site just runs without it, no error.
//
// Requires a self-hosted local Telegram Bot API server (see README) because
// the normal api.telegram.org only lets bots download files up to 20MB;
// the local server raises that to ~2GB.
function startTelegramBot({ s3, bucket, maxFileMB, io, getRoomMeta, saveRoomMeta, isValidCode, siteUrl }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const apiRoot = process.env.TELEGRAM_LOCAL_API_URL; // e.g. http://your-bot-api-host:8081

  if (!token || !apiRoot) {
    console.log('Telegram bot not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_LOCAL_API_URL to enable it).');
    return null;
  }

  // Telegram's own servers refuse to hand bots (even via a self-hosted
  // local API server) any file over ~2GB — this is a Telegram-side limit,
  // not something raising MAX_FILE_MB here can change. Whichever is
  // smaller wins.
  const TELEGRAM_HARD_CAP_MB = 2000;
  const effectiveMaxMB = maxFileMB ? Math.min(maxFileMB, TELEGRAM_HARD_CAP_MB) : TELEGRAM_HARD_CAP_MB;

  const bot = new Telegraf(token, { telegram: { apiRoot } });

  // Which room each Telegram chat is currently "tuned to." In-memory only —
  // resets if the server restarts, so a chat needs to re-send /room after
  // that. Fine for personal/small-team use; move this to the bucket like
  // room metadata if you need it to survive restarts.
  const activeRoom = new Map();

  bot.start((ctx) => ctx.reply(
    "Send me files and I'll drop them straight into a Wavelength room — no need to download from Telegram yourself.\n\n" +
    "First tell me which room:\n/room 1234\n\n" +
    `Then just send files — documents, photos, videos, audio all work, up to ${effectiveMaxMB}MB each.`
  ));

  function setRoom(ctx, code) {
    activeRoom.set(ctx.chat.id, code);
    ctx.reply(`Tuned to room ${code}. Send files now — they'll show up there instantly.`);
  }

  bot.command('room', (ctx) => {
    // Pull out the first run of exactly 4 digits anywhere after the
    // command, rather than splitting on a single space — this tolerates
    // "/room  1234" (double space), "/room@YourBot 1234", trailing
    // punctuation, etc.
    const match = ctx.message.text.match(/\d{4}/);
    const code = match ? match[0] : '';
    if (!isValidCode(code)) {
      return ctx.reply('Room codes are 4 digits, e.g. /room 4821');
    }
    setRoom(ctx, code);
  });

  // If someone just sends a bare 4-digit code with no /room prefix,
  // treat it the same way — matches how the website itself takes a code.
  bot.on('text', (ctx, next) => {
    const trimmed = ctx.message.text.trim();
    if (isValidCode(trimmed)) return setRoom(ctx, trimmed);
    return next();
  });

  const MAX_ATTEMPTS = 3;
  // In --local mode, getFile returns an absolute disk path under this
  // directory instead of a normal relative file_path. The custom nginx
  // image (see telegram-bot-api-docker/) serves that same directory as
  // static files, so we strip this known prefix and request the
  // remainder directly.
  const LOCAL_FILE_ROOT = '/var/lib/telegram-bot-api/';

  async function getDownloadUrl(fileId) {
    const file = await bot.telegram.getFile(fileId);
    let rel = file.file_path || '';
    if (rel.startsWith(LOCAL_FILE_ROOT)) rel = rel.slice(LOCAL_FILE_ROOT.length);
    else rel = rel.replace(/^\/+/, ''); // defensive fallback if the prefix ever changes
    return `${apiRoot.replace(/\/$/, '')}/${rel}`;
  }

  async function pullFileIntoRoom(fileId, name, mimeType, code, onProgress) {
    const downloadUrl = await getDownloadUrl(fileId);
    const res = await fetch(downloadUrl);
    if (!res.ok || !res.body) throw new Error('File fetch failed: HTTP ' + res.status + ' for ' + downloadUrl);

    const id = crypto.randomUUID();
    const ext = path.extname(name || '').slice(0, 20);
    const key = `files/${code}/${id}${ext}`;

    let bytes = 0;
    let lastReported = 0;
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', (chunk) => {
      bytes += chunk.length;
      if (onProgress && bytes - lastReported > 50 * 1024 * 1024) { // every ~50MB
        lastReported = bytes;
        onProgress(bytes);
      }
    });

    const upload = new Upload({
      client: s3,
      params: { Bucket: bucket, Key: key, Body: nodeStream, ContentType: mimeType || 'application/octet-stream' },
      queueSize: 4,
      partSize: 8 * 1024 * 1024
    });
    await upload.done();

    const meta = {
      id, name: name || id, size: bytes,
      type: mimeType || 'application/octet-stream',
      storageKey: key, uploadedAt: Date.now()
    };
    const existing = await getRoomMeta(code);
    await saveRoomMeta(code, existing.concat([meta]));
    io.to(code).emit('files-added', [meta]);
    return meta;
  }

  async function handleIncomingFile(ctx, { fileId, name, mimeType, size }) {
    const code = activeRoom.get(ctx.chat.id);
    if (!code) {
      return ctx.reply('Tell me which room first: /room 1234');
    }
    if (size && size > effectiveMaxMB * 1024 * 1024) {
      const reason = effectiveMaxMB === TELEGRAM_HARD_CAP_MB && (!maxFileMB || maxFileMB > TELEGRAM_HARD_CAP_MB)
        ? `Telegram itself won't hand bots anything over ${TELEGRAM_HARD_CAP_MB}MB \u2014 that's a Telegram limit, not this site's.`
        : `That's over the ${effectiveMaxMB}MB limit \u2014 skipped.`;
      return ctx.reply(reason);
    }

    const statusMsg = await ctx.reply('Pulling that in\u2026');
    const updateStatus = (text) => {
      ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text).catch(() => {});
    };

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const meta = await pullFileIntoRoom(fileId, name, mimeType, code, (bytes) => {
          updateStatus(`Pulling that in\u2026 ${(bytes / (1024 * 1024)).toFixed(0)}MB so far`);
        });
        const link2 = siteUrl ? `\n${siteUrl}/#/room/${code}` : '';
        return updateStatus(`Done \u2014 "${meta.name}" is live on ${code}${link2}`);
      } catch (e) {
        lastError = e;
        // Node wraps most network failures as a generic "fetch failed" —
        // the real reason lives in e.cause. Log both so it's actually
        // possible to tell what happened from Render's logs.
        console.error(
          `Telegram upload attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
          e.message, e.cause ? '| cause: ' + e.cause.message : ''
        );
        if (attempt < MAX_ATTEMPTS) {
          updateStatus(`Connection hiccup, retrying (${attempt}/${MAX_ATTEMPTS - 1})\u2026`);
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }
    }

    console.error('Telegram upload failed after retries:', lastError?.message, lastError?.cause?.message || '');
    updateStatus("Couldn't grab that file after a few tries \u2014 might be worth trying again, or a smaller file.");
  }

  bot.on('document', (ctx) => handleIncomingFile(ctx, {
    fileId: ctx.message.document.file_id,
    name: ctx.message.document.file_name,
    mimeType: ctx.message.document.mime_type,
    size: ctx.message.document.file_size
  }));

  bot.on('video', (ctx) => handleIncomingFile(ctx, {
    fileId: ctx.message.video.file_id,
    name: ctx.message.video.file_name || `video_${ctx.message.video.file_unique_id}.mp4`,
    mimeType: ctx.message.video.mime_type || 'video/mp4',
    size: ctx.message.video.file_size
  }));

  bot.on('audio', (ctx) => handleIncomingFile(ctx, {
    fileId: ctx.message.audio.file_id,
    name: ctx.message.audio.file_name || `audio_${ctx.message.audio.file_unique_id}.mp3`,
    mimeType: ctx.message.audio.mime_type || 'audio/mpeg',
    size: ctx.message.audio.file_size
  }));

  bot.on('voice', (ctx) => handleIncomingFile(ctx, {
    fileId: ctx.message.voice.file_id,
    name: `voice_${ctx.message.voice.file_unique_id}.ogg`,
    mimeType: ctx.message.voice.mime_type || 'audio/ogg',
    size: ctx.message.voice.file_size
  }));

  bot.on('photo', (ctx) => {
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    return handleIncomingFile(ctx, {
      fileId: largest.file_id,
      name: `photo_${largest.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      size: largest.file_size
    });
  });

  bot.launch();
  console.log('Telegram bot connected via local API server at', apiRoot);

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  return bot;
}

module.exports = { startTelegramBot };

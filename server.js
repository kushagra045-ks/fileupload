const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const { Server } = require('socket.io');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { startTelegramBot } = require('./telegramBot');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
// 2048 MB = 2GB default. Raise via env if you need bigger. Note this is
// enforced by this app, not by the storage provider.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 4096);
// Files older than this many hours are deleted automatically. Minimum
// sensible value is 1; set to 0 only if you really want files to live
// forever (not recommended once this is public — see the abuse notes in
// the README).
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS || 1);

// Optional: route downloads through a Cloudflare Worker that proxies the
// signed URL, so B2 egress goes through the free Bandwidth Alliance path
// instead of billing/capping against your B2 account directly. Leave unset
// to fall back to redirecting straight to the storage provider (original
// behavior). See README "Free egress via Cloudflare Worker" section.
const CF_WORKER_PROXY_URL = process.env.CF_WORKER_PROXY_URL
  ? process.env.CF_WORKER_PROXY_URL.replace(/\/$/, '')
  : null;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function corsOriginCheck(origin, callback) {
  if (ALLOWED_ORIGINS.includes('*') || !origin || ALLOWED_ORIGINS.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error('Not allowed by CORS: ' + origin));
  }
}

// ---------- S3-compatible object storage ----------
// Written against the generic S3 API so it works with Backblaze B2 (no
// credit card needed to sign up), Cloudflare R2, Wasabi, MinIO, or AWS S3
// itself — whichever you point it at. See README for exact setup steps
// per provider.
const S3_ENDPOINT = process.env.S3_ENDPOINT;       // e.g. https://s3.us-west-004.backblazeb2.com
const S3_REGION = process.env.S3_REGION;           // e.g. us-west-004 (shown next to your bucket)
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET = process.env.S3_BUCKET_NAME;

for (const [name, val] of Object.entries({ S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET })) {
  if (!val) {
    console.error(`Missing required env var for object storage: ${name}. See README for setup.`);
    process.exit(1);
  }
}

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true, // required by most non-AWS S3-compatible providers, harmless on AWS
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY
  }
});

function isValidCode(code) {
  return /^\d{4}$/.test(code);
}

function isExpired(meta) {
  if (!FILE_TTL_HOURS) return false;
  return Date.now() - meta.uploadedAt >= FILE_TTL_HOURS * 3600 * 1000;
}

function metaKey(code) {
  return `meta/${code}.json`;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- per-room metadata, stored as a small JSON object in the bucket ----------
async function getRoomMeta(code) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: metaKey(code) }));
    const text = await streamToString(res.Body);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return [];
    throw e;
  }
}
async function saveRoomMeta(code, list) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: metaKey(code),
    Body: JSON.stringify(list),
    ContentType: 'application/json'
  }));
}

function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------- automatic expiry sweep ----------
async function cleanupExpired() {
  if (!FILE_TTL_HOURS) return;
  try {
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET, Prefix: 'meta/', ContinuationToken: token
      }));
      for (const obj of page.Contents || []) {
        const code = obj.Key.slice('meta/'.length, -'.json'.length);
        try {
          const list = await getRoomMeta(code);
          const removed = list.filter(isExpired);
          if (!removed.length) continue;
          const kept = list.filter(f => !isExpired(f));
          if (kept.length) await saveRoomMeta(code, kept);
          else await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          for (const f of removed) {
            await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: f.storageKey })).catch(() => {});
            io.to(code).emit('file-removed', { id: f.id, reason: 'expired' });
          }
        } catch (e) {
          console.error('cleanup failed for room', code, e.message);
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (e) {
    console.error('cleanup sweep failed:', e.message);
  }
}
// Checked every 2 minutes so a 1-hour TTL is enforced fairly tightly.
if (FILE_TTL_HOURS) setInterval(cleanupExpired, 2 * 60 * 1000);

// ---------- app / server / sockets ----------
const app = express();
const server = http.createServer(app);
// Node kills requests after 5 minutes by default. A 2GB upload on a slow
// connection can take longer than that, so this is disabled. If you later
// put this behind a reverse proxy, that layer may have its own timeout.
server.requestTimeout = 0;
server.headersTimeout = 0;
const io = new Server(server, { cors: { origin: corsOriginCheck } });

app.use(cors({ origin: corsOriginCheck }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- upload handling: streams straight into the bucket, never touches disk ----------
class ObjectStorage {
  _handleFile(req, file, cb) {
    const code = req.params.code;
    const id = crypto.randomUUID();
    const ext = path.extname(file.originalname).slice(0, 20);
    const key = `files/${code}/${id}${ext}`;
    file.id = id;
    file.storageKey = key;

    let bytes = 0;
    file.stream.on('data', (chunk) => { bytes += chunk.length; });

    const upload = new Upload({
      client: s3,
      params: { Bucket: S3_BUCKET, Key: key, Body: file.stream, ContentType: file.mimetype },
      queueSize: 4,
      partSize: 8 * 1024 * 1024
    });

    upload.done()
      .then(() => cb(null, { size: bytes, storageKey: key }))
      .catch(err => cb(err));
  }

  _removeFile(req, file, cb) {
    if (!file.storageKey) return cb(null);
    s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: file.storageKey }))
      .catch(() => {})
      .finally(() => cb(null));
  }
}

const upload = multer({
  storage: new ObjectStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 }
});

function validateCode(req, res, next) {
  if (!isValidCode(req.params.code)) {
    return res.status(400).json({ error: 'Room code must be 4 digits.' });
  }
  next();
}

// let the frontend read current limits instead of hardcoding them
app.get('/api/config', (req, res) => {
  res.json({ maxFileMB: MAX_FILE_MB, fileTtlHours: FILE_TTL_HOURS });
});

// list files in a room
app.get('/api/rooms/:code/files', validateCode, async (req, res) => {
  try {
    const files = (await getRoomMeta(req.params.code)).filter(f => !isExpired(f));
    res.json({ files });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load files.' });
  }
});

// upload one or more files into a room
app.post('/api/rooms/:code/upload', validateCode, (req, res) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB}MB per file.` });
      }
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }
    const code = req.params.code;
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No files received.' });
    }
    const added = req.files.map(f => ({
      id: f.id,
      name: f.originalname,
      size: f.size,
      type: f.mimetype || 'application/octet-stream',
      storageKey: f.storageKey,
      uploadedAt: Date.now()
    }));
    try {
      const existing = await getRoomMeta(code);
      await saveRoomMeta(code, existing.concat(added));
      io.to(code).emit('files-added', added);
      res.json({ files: added });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Files uploaded but saving the room list failed. Try refreshing.' });
    }
  });
});

// download a single file — redirects the browser straight to a short-lived,
// signed URL so large files never get relayed through this server
app.get('/api/rooms/:code/files/:id/download', validateCode, async (req, res) => {
  const { code, id } = req.params;
  try {
    const list = await getRoomMeta(code);
    const meta = list.find(f => f.id === id);
    if (!meta) return res.status(404).send('File not found.');
    if (isExpired(meta)) return res.status(410).send('This file has expired.');
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: meta.storageKey,
      ResponseContentDisposition: contentDisposition(meta.name)
    }), { expiresIn: 300 });

    // If CF_WORKER_PROXY_URL is set, route the download through a Cloudflare
    // Worker instead of straight to the storage provider. The B2 -> Cloudflare
    // hop is free under the Bandwidth Alliance, and Workers never charge for
    // bandwidth out to the browser — so this avoids B2's 1GB/day free-download
    // cap entirely, with no card required on either side. See README.
    const target = CF_WORKER_PROXY_URL
      ? `${CF_WORKER_PROXY_URL}?url=${encodeURIComponent(url)}`
      : url;
    res.redirect(target);
  } catch (e) {
    console.error(e);
    res.status(500).send('Could not generate a download link.');
  }
});

// remove a single file
app.delete('/api/rooms/:code/files/:id', validateCode, async (req, res) => {
  const { code, id } = req.params;
  try {
    const list = await getRoomMeta(code);
    const idx = list.findIndex(f => f.id === id);
    if (idx === -1) return res.status(404).json({ error: 'File not found.' });
    const [meta] = list.splice(idx, 1);
    await saveRoomMeta(code, list);
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: meta.storageKey })).catch(() => {});
    io.to(code).emit('file-removed', { id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not remove that file.' });
  }
});

// fallback to the SPA shell for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- realtime ----------
io.on('connection', (socket) => {
  socket.on('join-room', (code) => { if (isValidCode(code)) socket.join(code); });
  socket.on('leave-room', (code) => { if (isValidCode(code)) socket.leave(code); });
});

// fail fast and clearly if the bucket/credentials are wrong, rather than
// mysteriously erroring on the first real upload
s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
  .then(() => {
    server.listen(PORT, () => console.log(`Wavelength running at http://localhost:${PORT}`));
    startTelegramBot({
      s3,
      bucket: S3_BUCKET,
      maxFileMB: MAX_FILE_MB,
      io,
      getRoomMeta,
      saveRoomMeta,
      isValidCode,
      siteUrl: process.env.PUBLIC_SITE_URL || null
    });
  })
  .catch((e) => {
    console.error('Could not reach storage bucket "' + S3_BUCKET + '":', e.message);
    console.error('Check S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_BUCKET_NAME.');
    process.exit(1);
  });

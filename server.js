const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { Server } = require('socket.io');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');
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
let CF_WORKER_PROXY_URL = null;
if (process.env.CF_WORKER_PROXY_URL) {
  const raw = process.env.CF_WORKER_PROXY_URL.trim().replace(/\/$/, '');
  // A value without a scheme (e.g. "my-worker.workers.dev" instead of
  // "https://my-worker.workers.dev") makes res.redirect() emit a relative
  // Location header — the browser then navigates to a path on YOUR OWN
  // site instead of the Worker, which hits the SPA catch-all route and
  // looks like "the page just refreshes and asks for the room code again".
  // Fail fast here instead of letting that happen silently.
  if (!/^https?:\/\//i.test(raw)) {
    console.error(
      `CF_WORKER_PROXY_URL is set to "${raw}" but is missing "https://" — ` +
      `this would silently break downloads (relative-redirect loop back to ` +
      `this server). Fix it to e.g. "https://${raw}" and redeploy.`
    );
    process.exit(1);
  }
  CF_WORKER_PROXY_URL = raw;
}

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
//const strictEncoded = encodeURIComponent(name)
   // .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

//  return `attachment; filename="${fallback}"; filename*=UTF-8''${strictEncoded}`;
function contentDisposition(name) {
<<<<<<< HEAD
const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
=======
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
>>>>>>> 82f928353e54aabca2d59efa590b844b48722852
const strictEncoded = encodeURIComponent(name)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  return `attachment; filename="${fallback}"; filename*=UTF-8''${strictEncoded}`;
  //return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Never cache the HTML shell itself — every load should get whatever
    // app.js currently ships, so a stale cached index.html/app.js pairing
    // (e.g. right after a deploy) can't mismatch and break routing.
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ---------- upload handling: browser uploads straight to the bucket via a
// presigned URL, so file bytes never pass through this server at all (this
// is what used to eat this app's Render bandwidth allowance the fastest —
// see README "Presigned direct-to-storage uploads" section) ----------
function storageKeyFor(code, id, originalname) {
  const ext = path.extname(originalname || '').slice(0, 20);
  return `files/${code}/${id}${ext}`;
}

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

// Step 1: mint a short-lived presigned PUT URL for one file. The browser
// will PUT the file bytes straight to the bucket with this URL — this
// server never sees them.
app.post('/api/rooms/:code/upload-url', validateCode, async (req, res) => {
  const code = req.params.code;
  const { filename, size, contentType } = req.body || {};

  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'filename is required.' });
  }
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  if (typeof size !== 'number' || size <= 0) {
    return res.status(400).json({ error: 'A valid file size is required.' });
  }
  if (size > maxBytes) {
    return res.status(413).json({ error: `File too large. Max ${MAX_FILE_MB}MB per file.` });
  }

  const id = crypto.randomUUID();
  const storageKey = storageKeyFor(code, id, filename);
  const type = contentType || 'application/octet-stream';

  try {
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: storageKey,
      ContentType: type
    }), { expiresIn: 3600 });

    res.json({ id, storageKey, uploadUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not prepare an upload URL.' });
  }
});

// Step 2: once the browser's direct PUT to the bucket finishes, it calls
// this to register the file in the room's metadata. This confirms the
// object actually landed (HeadObject) and reads the real size back from
// the bucket rather than trusting whatever the client claims.
app.post('/api/rooms/:code/upload-complete', validateCode, async (req, res) => {
  const code = req.params.code;
  const { id, storageKey, name, type } = req.body || {};

  if (!id || !storageKey || !name) {
    return res.status(400).json({ error: 'id, storageKey, and name are required.' });
  }
  // storageKey must be exactly the key we handed out for this room+id in
  // step 1 — this stops a client from registering an arbitrary key in the
  // bucket (e.g. another room's file, or a meta/ object) as its own upload.
  if (!storageKey.startsWith(`files/${code}/${id}`)) {
    return res.status(400).json({ error: 'storageKey does not match this room/upload.' });
  }

  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }));
    const added = [{
      id,
      name,
      size: head.ContentLength,
      type: type || head.ContentType || 'application/octet-stream',
      storageKey,
      uploadedAt: Date.now()
    }];
    const existing = await getRoomMeta(code);
    await saveRoomMeta(code, existing.concat(added));
    io.to(code).emit('files-added', added);
    res.json({ files: added });
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Upload not found in storage yet — it may have failed.' });
    }
    console.error(e);
    res.status(500).json({ error: 'File uploaded but saving the room list failed. Try refreshing.' });
  }
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
  res.set('Cache-Control', 'no-cache');
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

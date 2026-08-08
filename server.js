const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const ROOM_TTL_HOURS = Number(process.env.ROOM_TTL_HOURS || 0); // 0 = never expire

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'rooms.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- tiny json "database" ----------
// shape: { "1234": [ { id, name, size, type, storedName, uploadedAt } ] }
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

function isValidCode(code) {
  return /^\d{4}$/.test(code);
}

// ---------- optional cleanup of old rooms ----------
function cleanupExpired() {
  if (!ROOM_TTL_HOURS) return;
  const cutoff = Date.now() - ROOM_TTL_HOURS * 3600 * 1000;
  let changed = false;
  for (const code of Object.keys(db)) {
    const kept = db[code].filter(f => f.uploadedAt >= cutoff);
    const removed = db[code].filter(f => f.uploadedAt < cutoff);
    for (const f of removed) {
      const p = path.join(UPLOAD_DIR, code, f.storedName);
      fs.unlink(p, () => {});
    }
    if (removed.length) changed = true;
    if (kept.length) db[code] = kept;
    else delete db[code];
  }
  if (changed) saveDB();
}
if (ROOM_TTL_HOURS) setInterval(cleanupExpired, 30 * 60 * 1000);

// ---------- app / server / sockets ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(ROOT, 'public')));

// ---------- upload handling ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const code = req.params.code;
    const dir = path.join(UPLOAD_DIR, code);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    file.id = id; // stash so the route handler can read it back off req.files
    const ext = path.extname(file.originalname).slice(0, 20);
    cb(null, id + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 }
});

function validateCode(req, res, next) {
  if (!isValidCode(req.params.code)) {
    return res.status(400).json({ error: 'Room code must be 4 digits.' });
  }
  next();
}

// list files in a room
app.get('/api/rooms/:code/files', validateCode, (req, res) => {
  res.json({ files: db[req.params.code] || [] });
});

// upload one or more files into a room
app.post('/api/rooms/:code/upload', validateCode, (req, res) => {
  upload.array('files', 20)(req, res, (err) => {
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
    db[code] = db[code] || [];
    const added = req.files.map(f => ({
      id: f.id,
      name: f.originalname,
      size: f.size,
      type: f.mimetype || 'application/octet-stream',
      storedName: f.filename,
      uploadedAt: Date.now()
    }));
    db[code].push(...added);
    saveDB();
    io.to(code).emit('files-added', added);
    res.json({ files: added });
  });
});

// download a single file
app.get('/api/rooms/:code/files/:id/download', validateCode, (req, res) => {
  const { code, id } = req.params;
  const meta = (db[code] || []).find(f => f.id === id);
  if (!meta) return res.status(404).send('File not found.');
  const filePath = path.join(UPLOAD_DIR, code, meta.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk.');
  res.download(filePath, meta.name);
});

// remove a single file (lets people clear their own uploads if they want to)
app.delete('/api/rooms/:code/files/:id', validateCode, (req, res) => {
  const { code, id } = req.params;
  const list = db[code] || [];
  const idx = list.findIndex(f => f.id === id);
  if (idx === -1) return res.status(404).json({ error: 'File not found.' });
  const [meta] = list.splice(idx, 1);
  saveDB();
  fs.unlink(path.join(UPLOAD_DIR, code, meta.storedName), () => {});
  io.to(code).emit('file-removed', { id });
  res.json({ ok: true });
});

// fallback to the SPA shell for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// ---------- realtime ----------
io.on('connection', (socket) => {
  socket.on('join-room', (code) => {
    if (isValidCode(code)) socket.join(code);
  });
  socket.on('leave-room', (code) => {
    if (isValidCode(code)) socket.leave(code);
  });
});

server.listen(PORT, () => {
  console.log(`Wavelength running at http://localhost:${PORT}`);
});

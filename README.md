# Wavelength

Drop files into a 4-digit room. Anyone with the code sees them land in real time.

- Node.js + Express backend, files stored on disk
- Socket.io pushes new files to everyone in the room instantly (no polling)
- Room metadata persisted in `data/rooms.json` so it survives a server restart
- No accounts, no database to set up

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open **http://localhost:3000**. Click "Start a new frequency," or type in a
4-digit code someone shared with you to join their room. Open the same URL in
a second tab/browser to see files sync live between them.

## Configuration

Set these as environment variables (or in a `.env` file if you add `dotenv`):

| Variable         | Default | What it does                                              |
|------------------|---------|-------------------------------------------------------------|
| `PORT`           | `3000`  | Port the server listens on                                  |
| `MAX_FILE_MB`    | `100`   | Max size per uploaded file, in MB                            |
| `ROOM_TTL_HOURS` | `0`     | Auto-delete files older than this many hours (`0` = never)   |

Example:

```bash
PORT=8080 MAX_FILE_MB=250 npm start
```

## How it's structured

```
wavelength/
  server.js          Express API + Socket.io + file storage
  public/
    index.html        page shell
    style.css          all styling
    app.js              frontend logic (rooms, upload, download, live sync)
  data/rooms.json     auto-created: room -> file metadata
  uploads/<code>/     auto-created: actual uploaded files, one folder per room
```

Files are named by a random UUID on disk (not the original filename) to avoid
collisions and path traversal issues; the original filename is preserved in
the metadata and used again on download.

## Hosting split across Cloudflare Pages + a separate backend

Cloudflare Pages (and GitHub Pages) only serve static files — they can't run
`server.js`. If you want to keep the frontend on Cloudflare Pages, the
backend has to run somewhere else that hosts a persistent Node process
(Render, Railway, Fly.io, a VPS). Two pieces, two URLs, wired together with
CORS. Steps:

1. **Deploy the backend.** Push this whole repo to Render/Railway/Fly.io.
   Set the start command to `npm start`. Note the URL it gives you, e.g.
   `https://wavelength-backend.onrender.com`. If that platform has an
   ephemeral filesystem, attach a persistent disk/volume mounted at
   `uploads/` and `data/` (see the ephemeral-filesystem note further down) —
   otherwise every uploaded file disappears on the next deploy or restart.

2. **Lock down CORS.** On the backend host, set an environment variable:
   ```
   ALLOWED_ORIGIN=https://your-project.pages.dev
   ```
   (comma-separate multiple origins if you have a custom domain too, e.g.
   `https://your-project.pages.dev,https://files.yourdomain.com`). Without
   this it defaults to `*`, which works but allows any website to call your
   API.

3. **Point the frontend at the backend.** Edit `public/config.js`:
   ```js
   window.API_BASE = "https://wavelength-backend.onrender.com";
   ```
   Commit and push. Cloudflare Pages will redeploy the static site
   automatically if it's connected to your GitHub repo.

4. **Set the Pages build settings** (if you haven't already) so it only
   serves the `public/` folder: in the Cloudflare Pages project settings,
   set **Build output directory** to `public`, and leave the build command
   empty since there's nothing to build.

That's it — the static site on Pages now talks cross-origin to the Node
backend for uploads, downloads, and the live Socket.io connection. If
uploads still fail after this, open your browser's dev tools → Network tab
and check the failing request: a CORS error in the console means
`ALLOWED_ORIGIN` doesn't match your Pages URL exactly (check for a trailing
slash or `www.` mismatch); a `502`/timeout usually means the backend itself
isn't running or crashed — check its logs on Render/Railway/Fly.

## Hosting it yourself

Any place that runs a persistent Node process works: a VPS, Render, Railway,
Fly.io, a Raspberry Pi, etc.

**Plain VPS (Ubuntu/Debian example), with pm2 and nginx:**

```bash
# on the server
git clone <your-repo-or-copy-these-files> wavelength
cd wavelength
npm install
npm install -g pm2
pm2 start server.js --name wavelength
pm2 save
pm2 startup   # follow the printed instructions so it survives reboots
```

Then put nginx in front of it as a reverse proxy so you get a normal domain
and HTTPS. A minimal server block:

```nginx
server {
    listen 80;
    server_name files.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

The `Upgrade`/`Connection` headers are required — that's what lets Socket.io's
WebSocket connection pass through nginx instead of falling back to slower
long-polling. Then run `sudo certbot --nginx` (Certbot) to get a free HTTPS
certificate.

**Platforms like Render/Railway/Fly.io:** point them at this repo, set the
start command to `npm start`, and set `PORT` from their env if they require
a specific one (most inject it automatically, which this app already reads).

⚠️ One thing to check on these platforms specifically: many use an
**ephemeral filesystem**, meaning `uploads/` and `data/` get wiped on every
redeploy or restart. Look for a "persistent disk" or "volume" add-on and
mount it at `/app/uploads` and `/app/data` (or wherever you deploy this to)
if you want files to survive restarts. If you'd rather not deal with disks
at all, swapping the multer `diskStorage` for S3-compatible object storage
is a fairly small change to `server.js` — ask me if you want that version.

## Notes on the current design

- Room codes are just 4 digits (10,000 possible rooms) with no password —
  anyone who knows or guesses the code can see and add files. Treat it like
  a shared folder with a weak lock, not a secure vault. If you need real
  access control, the easiest addition is a per-room passphrase checked on
  join.
- There's no automatic expiry by default (`ROOM_TTL_HOURS=0`). Turn it on if
  you don't want files piling up forever.
- Uploads are capped by `MAX_FILE_MB` per file; there's no total storage cap,
  so on a small server you'll want to keep an eye on disk usage or set up a
  cron job to prune old room folders.

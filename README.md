# Wavelength

Drop files into a 4-digit room. Anyone with the code sees them land in real time.

- Node.js + Express backend
- **Files and room data are stored in Cloudflare R2**, not on the server's own
  disk — so nothing is lost when the server restarts, redeploys, or (on a
  free host) spins down from inactivity
- Socket.io pushes new files to everyone in the room instantly (no polling)
- Downloads redirect straight to R2 with a short-lived signed URL, so large
  files never get relayed through your server's bandwidth
- No accounts, no separate database to run

## Why R2 instead of local disk

The earlier version of this app stored files on the server's own disk. That
works fine on a machine you own, but on most hosting platforms (Render,
Railway, Fly.io, etc.) the disk is **ephemeral** — every restart, redeploy,
or free-tier spin-down wipes it, silently deleting every uploaded file. R2
fixes that: files live in object storage that's independent of your server's
lifecycle. It also removes any disk-space ceiling on your hosting plan, and
Cloudflare R2 has **no egress fees**, which matters a lot for a site whose
whole job is serving files.

## 1. Create the R2 bucket

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **R2 Object Storage** (sign up if you haven't; R2 has a free tier).
2. Click **Create bucket**. Name it something like `wavelength-files`. Location: Automatic is fine.
3. You don't need to make it public — this app only ever talks to R2 from the server side and via short-lived signed URLs, never a public bucket URL.

## 2. Create an API token (access key)

1. In the R2 section, click **Manage R2 API Tokens** (or **API** in the sidebar).
2. **Create API Token**.
3. Permissions: **Object Read & Write**, scoped to the bucket you just made (not "all buckets," to keep the blast radius small if the key ever leaks).
4. Create it, and copy the three values it shows you **immediately** — the secret is only shown once:
   - Access Key ID
   - Secret Access Key
   - Also note your **Account ID**, shown in the R2 dashboard's right sidebar or URL.

## 3. Set environment variables

Wherever you run this (locally or on your host), set:

| Variable                | Example                                  |
|--------------------------|-------------------------------------------|
| `R2_ACCOUNT_ID`          | `a1b2c3d4e5f6...`                          |
| `R2_ACCESS_KEY_ID`       | from step 2                                |
| `R2_SECRET_ACCESS_KEY`   | from step 2                                |
| `R2_BUCKET_NAME`         | `wavelength-files`                         |

The app **refuses to start** if any of these are missing, with a clear error
telling you which one — better than a confusing crash on the first upload.

## Run it locally

Requires Node.js 18+.

```bash
npm install
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET_NAME=wavelength-files
npm start
```

(Or put those in a `.env` file and use a tool like `dotenv-cli`, or just
paste them into your host's environment variables dashboard when deploying.)

Open **http://localhost:3000**. Click "Start a new frequency," or type in a
4-digit code someone shared with you to join their room. Open the same URL in
a second tab/browser to see files sync live between them.

## Configuration

| Variable         | Default | What it does                                              |
|------------------|---------|-------------------------------------------------------------|
| `PORT`           | `3000`  | Port the server listens on                                  |
| `MAX_FILE_MB`    | `2048`  | Max size per uploaded file, in MB (2048 = 2GB)               |
| `FILE_TTL_HOURS` | `1`     | Auto-delete files older than this many hours (`0` = never)   |
| `ALLOWED_ORIGIN` | `*`     | Comma-separated origins allowed to call the API (CORS)       |
| `R2_ACCOUNT_ID`  | —       | Required. From the R2 dashboard.                             |
| `R2_ACCESS_KEY_ID` | —     | Required. From your R2 API token.                            |
| `R2_SECRET_ACCESS_KEY` | — | Required. From your R2 API token.                            |
| `R2_BUCKET_NAME` | —       | Required. The bucket you created in step 1.                  |

The frontend reads `MAX_FILE_MB` and `FILE_TTL_HOURS` from the backend
automatically at `/api/config` — no need to duplicate them anywhere in
`public/`.

## Deploying on Render (or any Node host)

1. Push this repo to GitHub.
2. Render → **New Web Service** → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. In **Environment**, add all four `R2_*` variables from step 3 above, plus
   any of the optional ones you want to change from their defaults.
5. Deploy. Check the logs — you should see `Wavelength running at
   http://localhost:...` with no errors. If R2 credentials are wrong, you'll
   see a clear error naming the problem instead of a silent failure.

Because storage is now external, **the free tier's spin-down and ephemeral
disk stop being a data-loss risk** — your files are safe in R2 regardless of
what the server itself does. Spin-down still means a slow (30-60s) first
load after inactivity, but nothing gets deleted anymore. If that cold-start
delay itself is a problem, that's a separate fix (keep-alive ping, or a paid
instance) — ask if you want help with either.

## How it's structured

```
wavelength/
  server.js          Express API + Socket.io + R2 storage
  public/
    index.html        page shell
    style.css          all styling
    config.js           set window.API_BASE here if frontend/backend are split
    app.js              frontend logic (rooms, upload, download, live sync)
```

In R2, each uploaded file is stored under `files/<room-code>/<uuid><ext>`,
and each room's file list is a small JSON object at `meta/<room-code>.json`.
Files are named by a random UUID (not the original filename) to avoid
collisions; the original filename is preserved in the metadata and reapplied
on download via the `Content-Disposition` header.

## Notes on the current design

- Room codes are just 4 digits (10,000 possible rooms) with no password —
  anyone who knows or guesses the code can see and add files. Treat it like
  a shared folder with a weak lock, not a secure vault. If you need real
  access control, the easiest addition is a per-room passphrase checked on
  join.
- Automatic expiry is on by default (`FILE_TTL_HOURS=1`) — files vanish an
  hour after upload, both the R2 object and the metadata entry. Raise it if
  you want things to stick around longer, or set it to `0` to disable (not
  recommended once this is public).
- Uploads are capped by `MAX_FILE_MB` (2GB by default) per file; there's no
  total storage cap, so keep an eye on your R2 usage/bill as it grows —
  R2 is inexpensive but not literally free past its included tier.
- Room metadata is a simple read-modify-write JSON object per room. Two
  people uploading to the *exact* same room in the *exact* same instant can
  theoretically overwrite each other's metadata update (rare, and only
  affects the file list — never deletes the actual R2 objects). Fine for a
  hobby-scale app; a real database (Postgres, etc.) removes this edge case
  entirely if you outgrow it.
- Uploads still stream **through your server** on their way to R2 (not
  buffered in memory — this app streams them in small chunks — but the
  bytes do pass through). Downloads bypass the server entirely via signed
  URLs. If upload bandwidth ever becomes the bottleneck at scale, the next
  step is presigned direct-to-R2 uploads from the browser, which removes
  the server from the upload path too — a bigger change, ask if you want it
  built out.

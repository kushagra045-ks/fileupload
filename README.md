# Wavelength

Drop files into a 4-digit room. Anyone with the code sees them land in real time.

- Node.js + Express backend
- **Files and room data are stored in S3-compatible object storage**, not on
  the server's own disk — so nothing is lost when the server restarts,
  redeploys, or (on a free host) spins down from inactivity
- Written against the generic S3 API, so it works with **Backblaze B2**
  (no credit card required — the default this README sets up), Cloudflare
  R2, Wasabi, or AWS S3 itself, just by changing the endpoint/credentials
- Socket.io pushes new files to everyone in the room instantly (no polling)
- Downloads redirect straight to a signed URL, so large files never get
  relayed through your server's bandwidth
- No accounts, no separate database to run

## Why object storage instead of local disk

The earlier version of this app stored files on the server's own disk. That
works fine on a machine you own, but on most hosting platforms (Render,
Railway, Fly.io, etc.) the disk is **ephemeral** — every restart, redeploy,
or free-tier spin-down wipes it, silently deleting every uploaded file.
Object storage fixes that: files live somewhere independent of your
server's lifecycle.

## 1. Create a Backblaze B2 account and bucket

Backblaze B2 was chosen here specifically because signup doesn't require a
credit card — its free tier (10GB storage, generous free egress) works
immediately.

1. Go to **backblaze.com/sign-up/b2-cloud-storage-backup-archive** and create an account. No card needed.
2. In the B2 dashboard, click **Create a Bucket**.
3. Name it something globally unique, e.g. `wavelength-yourname-files`.
4. Set it to **Private**.
5. Once created, note the **Endpoint** shown on the bucket's page — it looks like `s3.us-west-004.backblazeb2.com`. The part between `s3.` and `.backblazeb2.com` (e.g. `us-west-004`) is your **region**.

## 2. Create an application key

1. In the B2 dashboard sidebar, go to **App Keys**.
2. Click **Add a New Application Key**.
3. Name it, e.g. `wavelength-server`.
4. Scope it to the bucket you just created (not "all buckets").
5. Permissions: **Read and Write**.
6. Click **Create New Key**. Copy both values shown **immediately** — the application key (secret) is only shown once:
   - **keyID** → this is your access key ID
   - **applicationKey** → this is your secret access key

## 3. Set environment variables

Wherever you run this (locally or on your host):

| Variable                | Example                                        |
|--------------------------|--------------------------------------------------|
| `S3_ENDPOINT`            | `https://s3.us-west-004.backblazeb2.com`          |
| `S3_REGION`               | `us-west-004`                                    |
| `S3_ACCESS_KEY_ID`        | the keyID from step 2                            |
| `S3_SECRET_ACCESS_KEY`    | the applicationKey from step 2                   |
| `S3_BUCKET_NAME`          | the bucket name from step 1                      |

The app **refuses to start** if any of these are missing, with a clear error
telling you which one — better than a confusing crash on the first upload.

**Using a different provider instead?** Same variables, different values:
- **Cloudflare R2**: `S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`, `S3_REGION=auto` (R2 requires a card, which is why B2 is the default here)
- **AWS S3**: `S3_ENDPOINT=https://s3.<region>.amazonaws.com`, `S3_REGION=<region>` (e.g. `us-east-1`)
- **Wasabi**: `S3_ENDPOINT=https://s3.<region>.wasabisys.com`

## Run it locally

Requires Node.js 18+.

```bash
npm install
export S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
export S3_REGION=us-west-004
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
export S3_BUCKET_NAME=wavelength-yourname-files
npm start
```

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
| `S3_ENDPOINT`    | —       | Required. Your storage provider's S3-compatible endpoint.    |
| `S3_REGION`      | —       | Required. The region matching that endpoint.                 |
| `S3_ACCESS_KEY_ID` | —     | Required.                                                    |
| `S3_SECRET_ACCESS_KEY` | — | Required.                                                    |
| `S3_BUCKET_NAME` | —       | Required.                                                    |

The frontend reads `MAX_FILE_MB` and `FILE_TTL_HOURS` from the backend
automatically at `/api/config` — no need to duplicate them anywhere in
`public/`.

## Deploying on Render (or any Node host)

1. Push this repo to GitHub.
2. Render → **New Web Service** → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. In **Environment**, add all five `S3_*` variables from step 3 above, plus
   any of the optional ones you want to change from their defaults.
5. Deploy. Check the logs — you should see `Wavelength running at
   http://localhost:...` with no errors. If credentials are wrong, you'll
   see a clear error naming the problem instead of a silent failure.

Because storage is now external, **the free tier's spin-down and ephemeral
disk stop being a data-loss risk** — your files are safe regardless of what
the server itself does. Spin-down still means a slow (30-60s) first load
after inactivity, but nothing gets deleted anymore.

## How it's structured

```
wavelength/
  server.js          Express API + Socket.io + object storage
  public/
    index.html        page shell
    style.css          all styling
    config.js           set window.API_BASE here if frontend/backend are split
    app.js              frontend logic (rooms, upload, download, live sync)
```

Each uploaded file is stored under `files/<room-code>/<uuid><ext>`, and each
room's file list is a small JSON object at `meta/<room-code>.json`. Files are
named by a random UUID (not the original filename) to avoid collisions; the
original filename is preserved in the metadata and reapplied on download via
the `Content-Disposition` header.

## Notes on the current design

- Room codes are just 4 digits (10,000 possible rooms) with no password —
  anyone who knows or guesses the code can see and add files. Treat it like
  a shared folder with a weak lock, not a secure vault. If you need real
  access control, the easiest addition is a per-room passphrase checked on
  join.
- Automatic expiry is on by default (`FILE_TTL_HOURS=1`) — files vanish an
  hour after upload, both the stored object and the metadata entry. Raise it
  if you want things to stick around longer, or set it to `0` to disable
  (not recommended once this is public).
- Uploads are capped by `MAX_FILE_MB` (2GB by default) per file. Backblaze
  B2's free tier includes 10GB of storage total — keep an eye on usage as
  it grows; past that it's roughly $6/TB/month, still inexpensive.
- Room metadata is a simple read-modify-write JSON object per room. Two
  people uploading to the *exact* same room in the *exact* same instant can
  theoretically overwrite each other's metadata update (rare, and only
  affects the file list — never deletes the actual stored files). Fine for
  a hobby-scale app; a real database removes this edge case entirely if you
  outgrow it.
- Uploads still stream **through your server** on their way to storage (not
  buffered in memory — streamed in small chunks — but the bytes do pass
  through). Downloads bypass the server entirely via signed URLs. If upload
  bandwidth ever becomes the bottleneck at scale, the next step is
  presigned direct-to-storage uploads from the browser, which removes the
  server from the upload path too — a bigger change, ask if you want it
  built out.

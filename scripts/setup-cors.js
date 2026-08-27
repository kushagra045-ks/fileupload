// One-time setup script: configures CORS on your S3-compatible bucket so
// browsers can upload directly to it (needed for the presigned-upload
// flow in server.js — without this, every direct PUT from the browser is
// blocked by the bucket before it ever gets your files).
//
// Run this once, from your own machine, with the same S3_* env vars you
// use for the app itself, plus ALLOWED_ORIGIN set to your site's real
// URL(s):
//
//   S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
//   S3_REGION=us-west-004 \
//   S3_ACCESS_KEY_ID=... \
//   S3_SECRET_ACCESS_KEY=... \
//   S3_BUCKET_NAME=wavelength-yourname-files \
//   ALLOWED_ORIGIN=https://your-wavelength-site.onrender.com \
//   node scripts/setup-cors.js
//
// Include http://localhost:3000 in ALLOWED_ORIGIN (comma-separated) too if
// you also upload while running the app locally.

const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;
const S3_BUCKET = process.env.S3_BUCKET_NAME;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

for (const [name, val] of Object.entries({ S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, ALLOWED_ORIGIN })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    console.error('See the comment at the top of this script for the full list.');
    process.exit(1);
  }
}

const origins = ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY
  }
});

async function main() {
  await s3.send(new PutBucketCorsCommand({
    Bucket: S3_BUCKET,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600
        }
      ]
    }
  }));
  console.log(`CORS configured on bucket "${S3_BUCKET}" for origin(s): ${origins.join(', ')}`);
  console.log('Direct browser uploads should now work.');
}

main().catch((e) => {
  console.error('Failed to set CORS on the bucket:', e.message);
  console.error('Double-check your S3_* credentials and that the key has permission to manage this bucket.');
  process.exit(1);
});

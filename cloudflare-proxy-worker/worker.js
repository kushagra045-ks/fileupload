// Wavelength download proxy — Cloudflare Worker
//
// Purpose: proxy downloads from your S3-compatible bucket (Backblaze B2 by
// default) through Cloudflare's network so egress is free under the
// Bandwidth Alliance, instead of counting against B2's 1GB/day free
// download cap. No Cloudflare card required — this runs on the Workers
// Free plan (100,000 requests/day, no bandwidth charges ever).
//
// How it's used: server.js generates the same short-lived signed URL it
// always did, then redirects the browser to:
//   https://<your-worker>.workers.dev/?url=<encoded signed url>
// This Worker fetches that URL server-side (on Cloudflare's network, so
// the B2 -> Cloudflare hop is free) and streams the response straight
// back to the browser.
//
// SECURITY: only proxies requests whose target hostname matches
// ALLOWED_HOST_SUFFIXES below, so this can't be turned into an open proxy
// for arbitrary URLs. Update the list if you switch storage providers.

const ALLOWED_HOST_SUFFIXES = [
  '.backblazeb2.com',   // Backblaze B2
  '.r2.cloudflarestorage.com', // Cloudflare R2 (if you switch later)
  '.wasabisys.com',     // Wasabi
  '.amazonaws.com'      // AWS S3
];

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('url');

    if (!target) {
      return new Response('Missing "url" query parameter.', { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response('Invalid target URL.', { status: 400 });
    }

    const allowed = ALLOWED_HOST_SUFFIXES.some(suffix =>
      targetUrl.hostname.endsWith(suffix)
    );
    if (!allowed) {
      return new Response('Forbidden: host not on the allow list.', { status: 403 });
    }

    // Only ever proxy GET/HEAD — this is a download-only proxy.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed.', { status: 405 });
    }

    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      // Forward range requests so video/audio scrubbing and resumable
      // downloads still work through the proxy.
      headers: request.headers.has('range')
        ? { range: request.headers.get('range') }
        : {}
    });

    // Stream the body straight through — Workers don't buffer this in
    // memory, and it doesn't count against CPU time since it's I/O wait,
    // so large files are fine on the free plan.
    const headers = new Headers(upstreamResponse.headers);
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers
    });
  }
};

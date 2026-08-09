#!/bin/sh
set -e

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo "TELEGRAM_API_ID and TELEGRAM_API_HASH are both required." >&2
  exit 1
fi

mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api

# Start the real Bot API server on an internal-only port. Always run in
# --local mode — that's the entire point of this image, so it's not left
# as an optional toggle the way the plain upstream image does it.
telegram-bot-api \
  --local \
  --http-port=8081 \
  --dir=/var/lib/telegram-bot-api \
  --temp-dir=/tmp/telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" &

BOTAPI_PID=$!

# Render tells us which port to listen on publicly via $PORT (defaults to
# 8081 to match what you likely already have set from the earlier setup).
PORT="${PORT:-8081}"
sed "s/__PORT__/${PORT}/" /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# If the Bot API process dies, bring the whole container down so Render
# restarts it cleanly, rather than limping along with nginx serving a
# dead backend.
( while kill -0 "$BOTAPI_PID" 2>/dev/null; do sleep 5; done; echo "telegram-bot-api exited, stopping container" >&2; kill -TERM 1 ) &

exec nginx -g 'daemon off;'

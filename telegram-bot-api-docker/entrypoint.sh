#!/bin/sh
set -e

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ]; then
  echo "TELEGRAM_API_ID and TELEGRAM_API_HASH are both required." >&2
  exit 1
fi

mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api

# Internal-only port for the real Bot API process — nginx is the only
# thing that talks to this directly, so it deliberately does NOT use
# $PORT (that's the public-facing port nginx binds to, below). Using two
# different fixed numbers here avoids the two processes ever fighting
# over the same port regardless of what $PORT gets set to.
BOTAPI_INTERNAL_PORT=8090

telegram-bot-api \
  --local \
  --http-port=$BOTAPI_INTERNAL_PORT \
  --dir=/var/lib/telegram-bot-api \
  --temp-dir=/tmp/telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" &

BOTAPI_PID=$!

# This is the port Render actually routes public traffic to. Render sets
# $PORT itself by default (usually 10000) — you generally don't need to
# set it manually for this service at all.
PORT="${PORT:-10000}"
sed \
  -e "s/__PORT__/${PORT}/" \
  -e "s/__BOTAPI_INTERNAL_PORT__/${BOTAPI_INTERNAL_PORT}/" \
  /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# If the Bot API process dies, bring the whole container down so Render
# restarts it cleanly, rather than limping along with nginx serving a
# dead backend.
( while kill -0 "$BOTAPI_PID" 2>/dev/null; do sleep 5; done; echo "telegram-bot-api exited, stopping container" >&2; kill -TERM 1 ) &

exec nginx -g 'daemon off;'

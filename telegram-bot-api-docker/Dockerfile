# Extends the exact same image you already have working (confirmed Alpine-
# based) instead of starting from a different base — this avoids the most
# common way a "bolt something onto a prebuilt image" build breaks: pulling
# in a binary that's linked against a different C library (glibc vs musl)
# than the rest of the image expects.
FROM aiogram/telegram-bot-api:latest

# The base image creates and may switch to a dedicated non-root user
# internally. Force back to root explicitly — both processes need to run
# as the same user for nginx to be able to read files telegram-bot-api
# writes (see nginx.conf.template for the other half of this fix).
USER root

# nginx will sit in front of telegram-bot-api on the single port Render
# exposes publicly, and separately serve raw files straight off disk —
# that second part is what --local mode needs but doesn't provide itself.
RUN apk add --no-cache nginx

COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 10000

ENTRYPOINT ["/entrypoint.sh"]

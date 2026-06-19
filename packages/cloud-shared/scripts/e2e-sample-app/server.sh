#!/bin/sh
# Minimal "user app" for the Apps/Product 2 end-to-end proof: connect to the
# per-tenant DATABASE_URL the platform injected, then serve that DB identity over
# HTTP (the app's URL). Stands in for any user web app that has its own database.
set -u
PORT="${PORT:-3000}"

# Reach OUR OWN isolated tenant DB (proves app -> isolated DB connectivity).
DBINFO="$(psql "$DATABASE_URL" -tAc "select 'db='||current_database()||' user='||current_user" 2>&1 | head -1)"
echo "[sample-app] DATABASE_URL connect -> $DBINFO"

BODY="hello from app | $DBINFO"
LEN=$(printf '%s' "$BODY" | wc -c)

# Serve the identity over HTTP on $PORT; one busybox-nc accept per request.
echo "[sample-app] serving on :$PORT"
while true; do
  printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$LEN" "$BODY" | nc -l -p "$PORT"
done

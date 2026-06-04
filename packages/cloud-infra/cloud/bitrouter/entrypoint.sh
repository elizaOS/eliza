#!/usr/bin/env sh
set -eu

mkdir -p /data

export BITROUTER_DATABASE_URL="${BITROUTER_DATABASE_URL:-sqlite:/data/bitrouter.db}"
export BITROUTER_INTERNAL_JWT_FILE="${BITROUTER_INTERNAL_JWT_FILE:-/data/internal.jwt}"
export OWS_PASSPHRASE="${OWS_PASSPHRASE:-$BITROUTER_PROXY_TOKEN}"

database_path="${BITROUTER_DATABASE_URL#sqlite:}"
touch "$database_path"

if ! bitrouter wallet list --config-file /app/bitrouter.yaml --db "$BITROUTER_DATABASE_URL" --no-tui \
  | grep -q '^eliza-cloud[[:space:]]'; then
  expect <<'EXPECT'
set timeout 30
spawn bitrouter wallet create --name eliza-cloud --config-file /app/bitrouter.yaml --db $env(BITROUTER_DATABASE_URL) --no-tui
expect "Set passphrase"
send "$env(OWS_PASSPHRASE)\r"
expect "Confirm passphrase"
send "$env(OWS_PASSPHRASE)\r"
expect eof
EXPECT
fi

expect <<'EXPECT' | awk '/^eyJ/ { token=$0 } END { if (token) print token }' > "$BITROUTER_INTERNAL_JWT_FILE"
set timeout 30
spawn bitrouter key sign --wallet eliza-cloud --models * --exp 30d --raw --config-file /app/bitrouter.yaml --db $env(BITROUTER_DATABASE_URL) --no-tui
expect "Wallet owner passphrase"
send "$env(OWS_PASSPHRASE)\r"
expect eof
EXPECT
chmod 600 "$BITROUTER_INTERNAL_JWT_FILE"

if [ ! -s "$BITROUTER_INTERNAL_JWT_FILE" ]; then
  echo "failed to mint BitRouter internal JWT" >&2
  exit 1
fi

bitrouter serve --config-file /app/bitrouter.yaml --db "$BITROUTER_DATABASE_URL" &
bitrouter_pid="$!"

cleanup() {
  kill "$bitrouter_pid" 2>/dev/null || true
}
trap cleanup INT TERM

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4356/health >/dev/null 2>&1; then
    exec node /app/auth-proxy.mjs
  fi
  sleep 1
done

echo "bitrouter did not become healthy" >&2
exit 1

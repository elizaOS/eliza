#!/usr/bin/env bash
# Local-docker proof (Apps / Product 2): the apps INGRESS routing mechanism.
# Proves, against a REAL stock Caddy with admin-origin enforcement, that a
# per-app Host header reverse-proxies to that app's container through the real
# ingress provisioner, and that removing the route stops routing. Plain HTTP
# (no domain/TLS; on-demand TLS is validated on real infra). No mocks.
#   bash packages/cloud/scripts/shared/verify-apps-ingress-routing.sh
set -euo pipefail
cd "$(dirname "$0")/../../shared" || exit 1 # -> packages/cloud/shared
WORK="$(mktemp -d "${TMPDIR:-/tmp}/apps-ingress.XXXXXX")"
RUN_ID="${WORK##*/}"
NET="$RUN_ID-net"
APP="$RUN_ID-app"
CADDY="$RUN_ID-caddy"
NET_ID=""; APP_ID=""; CADDY_ID=""
HOST=abc12345.apps.eliza.app
PASS=0
FAIL=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; PASS=$((PASS + 1)); else echo "FAIL  $2 ${3:-}"; FAIL=$((FAIL + 1)); fi; }
cleanup() {
  [ -z "$APP_ID" ] || docker rm -f "$APP_ID" >/dev/null 2>&1 || true
  [ -z "$CADDY_ID" ] || docker rm -f "$CADDY_ID" >/dev/null 2>&1 || true
  [ -z "$NET_ID" ] || docker network rm "$NET_ID" >/dev/null 2>&1 || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT

read -r PROXY_PORT ADMIN_PORT < <(bun -e '
  const servers = [Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }),
    Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })];
  console.log(servers.map(server => server.port).join(" "));
  servers.forEach(server => server.stop(true));
')
[[ "$PROXY_PORT" =~ ^[0-9]+$ && "$ADMIN_PORT" =~ ^[0-9]+$ ]]

NET_ID="$(docker network create "$NET")"

echo "=== stock Caddy: admin API + empty srv0 on :80 ==="
cat >"$WORK/init.json" <<JSON
{"admin":{"listen":"0.0.0.0:2019","origins":["http://localhost:$ADMIN_PORT"],"enforce_origin":true},"apps":{"http":{"servers":{"srv0":{"listen":[":80"],"routes":[]}}}}}
JSON
CADDY_ID="$(docker create --name "$CADDY" --network "$NET_ID" -p "127.0.0.1:$PROXY_PORT:80" -p "127.0.0.1:$ADMIN_PORT:2019" \
  -v "$WORK/init.json:/init.json" caddy:2 caddy run --config /init.json)"
docker start "$CADDY_ID" >/dev/null
for _ in $(seq 1 25); do
  curl -fsS -H "Origin: http://localhost:$ADMIN_PORT" "http://localhost:$ADMIN_PORT/config/" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS -H "Origin: http://localhost:$ADMIN_PORT" "http://localhost:$ADMIN_PORT/config/" >/dev/null

echo "=== origin-less admin request is rejected ==="
ADMIN_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:$ADMIN_PORT/config/")
if [ "$ADMIN_STATUS" = 403 ]; then
  check ok "Caddy admin origin enforcement rejects an origin-less request"
else
  check fail "Caddy admin origin enforcement" "expected 403, got $ADMIN_STATUS"
fi

echo "=== sample app (http-echo) co-located in Caddy's netns (mirrors loopback-only publish) ==="
# In prod the container publishes to 127.0.0.1:hostPort and the node-local Caddy
# dials 127.0.0.1:hostPort. Reproduce that here by sharing Caddy's network
# namespace, so the app is reachable at 127.0.0.1:5678 from Caddy (and ONLY there).
APP_ID="$(docker create --name "$APP" --network "container:$CADDY_ID" \
  hashicorp/http-echo -text="ROUTED-TO-APP" -listen=:5678)"
docker start "$APP_ID" >/dev/null

echo "=== add the route through the REAL origin-aware ingress provisioner ==="
bun -e "import{addAppRoute}from'./src/lib/services/apps-ingress-provisioner';await addAppRoute({hostname:'$HOST',hostPort:5678,adminBase:'http://localhost:$ADMIN_PORT'})"
echo "route posted"

echo "=== request with the app's Host header -> reaches the app ==="
RESP=""
for _ in $(seq 1 20); do
  RESP=$(curl -sS -H "Host: $HOST" "http://localhost:$PROXY_PORT/")
  echo "$RESP" | grep -q "ROUTED-TO-APP" && break
  sleep 0.25
done
echo "response: $RESP"
echo "$RESP" | grep -q "ROUTED-TO-APP" &&
  check ok "Host: $HOST reverse-proxied to the app container (real Caddy admin-API route)" ||
  check fail "routing" "got: $RESP"

echo "=== an UNKNOWN host is NOT routed ==="
RESP_X=$(curl -s -H "Host: nope.apps.eliza.app" "http://localhost:$PROXY_PORT/")
echo "$RESP_X" | grep -q "ROUTED-TO-APP" &&
  check fail "unknown host isolation" "leaked: $RESP_X" ||
  check ok "unknown host is NOT routed to the app"

echo "=== DELETE the route by @id -> host no longer routes ==="
bun -e "import{removeAppRoute}from'./src/lib/services/apps-ingress-provisioner';await removeAppRoute({hostname:'$HOST',adminBase:'http://localhost:$ADMIN_PORT'})"
echo "route deleted"
RESP2=$(curl -s -H "Host: $HOST" "http://localhost:$PROXY_PORT/")
echo "$RESP2" | grep -q "ROUTED-TO-APP" &&
  check fail "route removal" "still routed: $RESP2" ||
  check ok "route DELETE by @id removed it (host no longer reaches the app)"

echo "=== $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))

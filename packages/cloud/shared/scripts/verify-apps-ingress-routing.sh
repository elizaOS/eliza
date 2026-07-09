#!/usr/bin/env bash
# Local-docker proof (Apps / Product 2): the apps INGRESS routing mechanism.
# Proves, against a REAL stock Caddy with admin-origin enforcement, that a
# per-app Host header reverse-proxies to that app's container through the real
# ingress provisioner, and that removing the route stops routing. Plain HTTP
# (no domain/TLS; on-demand TLS is validated on real infra). No mocks.
#   bash packages/cloud/shared/scripts/verify-apps-ingress-routing.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1 # -> packages/cloud/shared
NET=apps-ing-net
APP=apps-ing-app
CADDY=apps-ing-caddy
HOST=abc12345.apps.elizacloud.ai
PROXY_PORT=18080
ADMIN_PORT=12019
PASS=0
FAIL=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; PASS=$((PASS + 1)); else echo "FAIL  $2 ${3:-}"; FAIL=$((FAIL + 1)); fi; }
cleanup() {
  docker rm -f "$APP" "$CADDY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -f /tmp/apps-ing-init.json
}
trap cleanup EXIT

docker network create "$NET" >/dev/null 2>&1 || true

echo "=== stock Caddy: admin API + empty srv0 on :80 ==="
cat >/tmp/apps-ing-init.json <<JSON
{"admin":{"listen":"0.0.0.0:2019","origins":["http://localhost:$ADMIN_PORT"],"enforce_origin":true},"apps":{"http":{"servers":{"srv0":{"listen":[":80"],"routes":[]}}}}}
JSON
docker run -d --name "$CADDY" --network "$NET" -p "$PROXY_PORT:80" -p "$ADMIN_PORT:2019" \
  -v /tmp/apps-ing-init.json:/init.json caddy:2 caddy run --config /init.json >/dev/null
for _ in $(seq 1 25); do
  curl -fsS -H "Origin: http://localhost:$ADMIN_PORT" "http://localhost:$ADMIN_PORT/config/" >/dev/null 2>&1 && break
  sleep 1
done

echo "=== sample app (http-echo) co-located in Caddy's netns (mirrors loopback-only publish) ==="
# In prod the container publishes to 127.0.0.1:hostPort and the node-local Caddy
# dials 127.0.0.1:hostPort. Reproduce that here by sharing Caddy's network
# namespace, so the app is reachable at 127.0.0.1:5678 from Caddy (and ONLY there).
docker run -d --name "$APP" --network "container:$CADDY" \
  hashicorp/http-echo -text="ROUTED-TO-APP" -listen=:5678 >/dev/null

echo "=== add the route through the REAL origin-aware ingress provisioner ==="
bun -e "import{addAppRoute}from'./src/lib/services/apps-ingress-provisioner';await addAppRoute({hostname:'$HOST',hostPort:5678,adminBase:'http://localhost:$ADMIN_PORT'})"
echo "route posted"

echo "=== request with the app's Host header -> reaches the app ==="
RESP=$(curl -s -H "Host: $HOST" "http://localhost:$PROXY_PORT/")
echo "response: $RESP"
echo "$RESP" | grep -q "ROUTED-TO-APP" &&
  check ok "Host: $HOST reverse-proxied to the app container (real Caddy admin-API route)" ||
  check fail "routing" "got: $RESP"

echo "=== an UNKNOWN host is NOT routed ==="
RESP_X=$(curl -s -H "Host: nope.apps.elizacloud.ai" "http://localhost:$PROXY_PORT/")
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

#!/usr/bin/env bash
# Local-docker proof (Apps / Product 2): the apps INGRESS routing mechanism.
# Proves, against a REAL stock Caddy, that a per-app Host header reverse-proxies
# to that app's container via a route added to Caddy's admin API — built by the
# REAL `apps-ingress-routes` builders — and that deleting the route by @id stops
# routing, while an unknown host is never routed. Plain HTTP (no domain/TLS;
# on-demand TLS is validated on real infra). No mocks.
#   bash packages/cloud-shared/scripts/verify-apps-ingress-routing.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1 # -> packages/cloud-shared
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

echo "=== sample app (http-echo) on the shared net ==="
docker run -d --name "$APP" --network "$NET" hashicorp/http-echo -text="ROUTED-TO-APP" -listen=:5678 >/dev/null

echo "=== stock Caddy: admin API + empty srv0 on :80 ==="
cat >/tmp/apps-ing-init.json <<'JSON'
{"admin":{"listen":"0.0.0.0:2019"},"apps":{"http":{"servers":{"srv0":{"listen":[":80"],"routes":[]}}}}}
JSON
docker run -d --name "$CADDY" --network "$NET" -p "$PROXY_PORT:80" -p "$ADMIN_PORT:2019" \
  -v /tmp/apps-ing-init.json:/init.json caddy:2 caddy run --config /init.json >/dev/null
for _ in $(seq 1 25); do curl -fsS "http://localhost:$ADMIN_PORT/config/" >/dev/null 2>&1 && break; sleep 1; done

echo "=== build the route via the REAL builder + POST to Caddy admin API ==="
# upstream = the app container:port on the shared net (stands in for node:hostPort)
ROUTE=$(bun -e "import{buildCaddyRoute}from'./src/lib/services/apps-ingress-routes';process.stdout.write(JSON.stringify(buildCaddyRoute({hostname:'$HOST',nodeHost:'$APP',hostPort:5678})))")
echo "route: $ROUTE"
ADD_URL=$(bun -e "import{buildCaddyAddRouteUrl}from'./src/lib/services/apps-ingress-routes';process.stdout.write(buildCaddyAddRouteUrl('http://localhost:$ADMIN_PORT'))")
curl -fsS -X POST -H 'Content-Type: application/json' -d "$ROUTE" "$ADD_URL" >/dev/null && echo "route posted"

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
RID=$(bun -e "import{buildCaddyRouteId}from'./src/lib/services/apps-ingress-routes';process.stdout.write(buildCaddyRouteId('$HOST'))")
DEL_URL=$(bun -e "import{buildCaddyRouteByIdUrl}from'./src/lib/services/apps-ingress-routes';process.stdout.write(buildCaddyRouteByIdUrl('http://localhost:$ADMIN_PORT','$RID'))")
curl -fsS -X DELETE "$DEL_URL" >/dev/null && echo "route $RID deleted"
RESP2=$(curl -s -H "Host: $HOST" "http://localhost:$PROXY_PORT/")
echo "$RESP2" | grep -q "ROUTED-TO-APP" &&
  check fail "route removal" "still routed: $RESP2" ||
  check ok "route DELETE by @id removed it (host no longer reaches the app)"

echo "=== $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))

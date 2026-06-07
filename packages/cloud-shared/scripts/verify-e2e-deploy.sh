#!/usr/bin/env bash
# FULL end-to-end deploy proof (Apps / Product 2) on REAL local infra — the whole
# flow the goal describes, no mocks, no VPS, no prod:
#   build user image (real AppImageBuilder + docker build)
#     -> provision per-tenant DB (real composed stack)
#     -> run the image as an --internal isolated container with its per-tenant DSN
#     -> it reaches ITS OWN DB and serves its URL
#     -> it CANNOT reach another tenant's DB (REVOKE CONNECT)
#     -> it has NO internet egress (--internal)
#
# Requires: sudo docker (passwordless), bun. Run from packages/cloud-shared/.
set -uo pipefail

PG=apps-tenant-pg
PGPORT=55445
PGPASS=adminpw
IMG=postgres:16-alpine
SEEDNET=apps-seednet
APP_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
APP_RUN=app-run
INGRESS=app-ingress
PASS=0; FAIL=0
check(){ if [ "$1" = ok ]; then echo "PASS  $2"; PASS=$((PASS+1)); else echo "FAIL  $2 ${3:-}"; FAIL=$((FAIL+1)); fi; }

cleanup(){
  sudo docker rm -f "$APP_RUN" "$INGRESS" "$PG" >/dev/null 2>&1 || true
  [ -n "${APPNET:-}" ] && sudo docker network rm "$APPNET" >/dev/null 2>&1 || true
  sudo docker network rm "$SEEDNET" >/dev/null 2>&1 || true
  sudo docker rmi -f "${IMAGE_REF:-}" >/dev/null 2>&1 || true
  rm -f /tmp/e2e-dsns.json
}
trap cleanup EXIT

echo "=== 1) BUILD the user app image via the REAL AppImageBuilder (local docker build) ==="
IMAGE_REF=$(REGISTRY=apps-local APP_ID="$APP_ID" CONTEXT=scripts/e2e-sample-app \
  bun run scripts/_e2e-build.ts) || { echo "build FAILED"; exit 1; }
echo "built: $IMAGE_REF"
sudo docker image inspect "$IMAGE_REF" >/dev/null 2>&1 \
  && check ok "build pipeline produced a real local image ($IMAGE_REF)" \
  || { check fail "image build"; exit 1; }

echo
echo "=== 2) PROVISION per-tenant DBs through the real composed stack ==="
sudo docker rm -f "$PG" >/dev/null 2>&1 || true
sudo docker network rm "$SEEDNET" >/dev/null 2>&1 || true
sudo docker network create --driver bridge "$SEEDNET" >/dev/null
sudo docker run -d --name "$PG" --network "$SEEDNET" -p "$PGPORT:5432" \
  -e POSTGRES_PASSWORD="$PGPASS" "$IMG" >/dev/null
for i in $(seq 1 30); do sudo docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

export ADMIN_DSN="postgresql://postgres:${PGPASS}@localhost:${PGPORT}/postgres?sslmode=disable"
export CLUSTER_HOST="${PG}:5432"
export DATABASE_URL="$ADMIN_DSN"
bun run scripts/_e2e-provision.ts > /tmp/e2e-dsns.json || { echo "provision FAILED"; cat /tmp/e2e-dsns.json; exit 1; }
DSN_A=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').a.dsn)")
DSN_B=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').b.dsn)")
DB_A=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').a.db)")
DB_B=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').b.db)")
DSN_A_L=${DSN_A/sslmode=require/sslmode=disable}
DSN_B_L=${DSN_B/sslmode=require/sslmode=disable}
CROSS=${DSN_B_L/\/$DB_B\?/\/$DB_A\?}   # tenant B creds aimed at tenant A's DB
echo "tenant A db=$DB_A"

echo
echo "=== 3) RUN the image as an --internal isolated container with its per-tenant DSN ==="
# Build the per-app --internal network via the REAL builder, then attach the DB
# to it (the tenant DB sits on an allowed path; the internet does not).
APPNET=$(bun -e "import {appNetworkName} from './src/lib/services/app-network-utils'; process.stdout.write(appNetworkName('$APP_ID'))")
BUILDER_CMD=$(bun -e "import {buildEnsureAppNetworkCmd,appNetworkName} from './src/lib/services/app-network-utils'; process.stdout.write(buildEnsureAppNetworkCmd(appNetworkName('$APP_ID')))")
sudo sh -c "$BUILDER_CMD"
sudo docker network connect "$APPNET" "$PG"   # tenant DB reachable on the isolated net
SECFLAGS=$(bun -e "import {buildAppContainerSecurityFlags} from './src/lib/services/app-network-utils'; process.stdout.write(buildAppContainerSecurityFlags().join(' '))")
echo "security flags: $SECFLAGS"
sudo docker run -d --name "$APP_RUN" --network "$APPNET" $SECFLAGS \
  -e DATABASE_URL="$DSN_A_L" -e PORT=3000 "$IMAGE_REF" >/dev/null
sleep 4

echo
echo "=== 4) app reaches ITS OWN DB + serves its URL ==="
LOGS=$(sudo docker logs "$APP_RUN" 2>&1)
echo "$LOGS" | grep -q "db=$DB_A" \
  && check ok "deployed app connected to its OWN isolated DB ($DB_A)" \
  || check fail "app->own DB" "logs: $(echo "$LOGS" | head -2 | tr '\n' ' ')"

# The "URL": an ingress sibling on the app network fetches the app (prod ingress
# reaches the container over the docker network, exactly like this).
URLBODY=$(sudo docker run --rm --network "$APPNET" "$IMG" \
  sh -c "for i in 1 2 3 4 5; do wget -qO- http://$APP_RUN:3000/ 2>/dev/null && break; sleep 1; done")
echo "URL body: $URLBODY"
echo "$URLBODY" | grep -q "db=$DB_A" \
  && check ok "app serves its URL (HTTP) returning its own DB identity" \
  || check fail "app URL serve" "got: $URLBODY"

echo
echo "=== 5) app CANNOT reach another tenant's DB (REVOKE CONNECT) ==="
XOUT=$(sudo docker run --rm --network "$APPNET" "$IMG" psql "$CROSS" -tAc "select 1" 2>&1)
echo "$XOUT" | grep -qiE "permission denied for database" \
  && check ok "cross-tenant DB access REJECTED from the isolated container" \
  || check fail "cross-tenant rejection" "got: $(echo "$XOUT" | head -1)"

echo
echo "=== 6) app has NO internet egress (--internal) ==="
EOUT=$(sudo docker run --rm --network "$APPNET" "$IMG" \
  sh -c "timeout 5 wget -qO- http://1.1.1.1/ 2>&1; echo EXIT=\$?")
echo "$EOUT" | grep -qiE "bad address|download timed out|timed out|EXIT=[^0]" \
  && check ok "isolated container has NO internet egress" \
  || check fail "egress block" "got: $(echo "$EOUT" | head -1)"

echo
echo "=== $PASS passed, $FAIL failed ==="
exit $((FAIL>0 ? 1 : 0))

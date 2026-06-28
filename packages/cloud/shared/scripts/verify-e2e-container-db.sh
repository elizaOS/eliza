#!/usr/bin/env bash
# E2E real-Docker verification (Apps / Product 2): a REAL container process
# reaches its OWN isolated Postgres DB, is REJECTED from another tenant's DB
# (REVOKE CONNECT, over real docker networking), and our REAL --internal network
# builder blocks egress. No mocks, no VPS, no prod — throwaway resources only.
#
# Requires: sudo docker, bun. Run from packages/cloud-shared/.
#   bash scripts/verify-e2e-container-db.sh
set -uo pipefail

NET_DB="apps-dbnet"
PG="apps-tenant-pg"
PGPORT=55444
PGPASS=adminpw
IMG=postgres:16-alpine
PASS=0; FAIL=0
check() { if [ "$1" = "ok" ]; then echo "PASS  $2"; PASS=$((PASS+1)); else echo "FAIL  $2 ${3:-}"; FAIL=$((FAIL+1)); fi; }

cleanup() {
  sudo docker rm -f "$PG" >/dev/null 2>&1 || true
  # remove the per-app --internal net if it was created
  [ -n "${APPNET:-}" ] && sudo docker network rm "$APPNET" >/dev/null 2>&1 || true
  sudo docker network rm "$NET_DB" >/dev/null 2>&1 || true
  rm -f /tmp/e2e-dsns.json
}
trap cleanup EXIT

echo "=== setup: throwaway tenant-PG on a real docker network ==="
sudo docker rm -f "$PG" >/dev/null 2>&1 || true
sudo docker network rm "$NET_DB" >/dev/null 2>&1 || true
sudo docker network create --driver bridge "$NET_DB" >/dev/null
sudo docker run -d --name "$PG" --network "$NET_DB" -p "$PGPORT:5432" \
  -e POSTGRES_PASSWORD="$PGPASS" "$IMG" >/dev/null
# wait for readiness
for i in $(seq 1 30); do
  if sudo docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "=== provision two tenants through the REAL composer (host side) ==="
export ADMIN_DSN="postgresql://postgres:${PGPASS}@localhost:${PGPORT}/postgres?sslmode=disable"
export CLUSTER_HOST="${PG}:5432"
export DATABASE_URL="$ADMIN_DSN"
bun run scripts/_e2e-provision.ts > /tmp/e2e-dsns.json || { echo "provisioning FAILED"; cat /tmp/e2e-dsns.json; exit 1; }
cat /tmp/e2e-dsns.json

DSN_A=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').a.dsn)")
DSN_B=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').b.dsn)")
DB_A=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').a.db)")
DB_B=$(node -e "process.stdout.write(require('/tmp/e2e-dsns.json').b.db)")
# sslmode=require -> disable for the no-TLS throwaway PG
DSN_A_L=${DSN_A/sslmode=require/sslmode=disable}
DSN_B_L=${DSN_B/sslmode=require/sslmode=disable}
# tenant B's creds aimed at tenant A's database (the cross-tenant attempt)
CROSS=${DSN_B_L/\/$DB_B\?/\/$DB_A\?}

echo
echo "=== DATA PLANE: real app containers over real docker networking ==="
# 1) App A container reaches its OWN database.
OUT=$(sudo docker run --rm --network "$NET_DB" "$IMG" psql "$DSN_A_L" -tAc "select current_database()" 2>&1)
[ "$OUT" = "$DB_A" ] && check ok "app-A container connects to its OWN isolated DB ($DB_A)" || check fail "app-A own DB" "got: $OUT"

# 2) App B container reaches its OWN database (sanity).
OUT=$(sudo docker run --rm --network "$NET_DB" "$IMG" psql "$DSN_B_L" -tAc "select current_database()" 2>&1)
[ "$OUT" = "$DB_B" ] && check ok "app-B container connects to its OWN isolated DB ($DB_B)" || check fail "app-B own DB" "got: $OUT"

# 3) THE BOUNDARY: app B's role, from a container, CANNOT open app A's DB.
OUT=$(sudo docker run --rm --network "$NET_DB" "$IMG" psql "$CROSS" -tAc "select 1" 2>&1)
echo "$OUT" | grep -qiE "permission denied for database" \
  && check ok "cross-tenant REJECTED through a real container (REVOKE CONNECT)" \
  || check fail "cross-tenant rejection" "got: $(echo "$OUT" | head -1)"

echo
echo "=== NETWORK PLANE: our REAL buildEnsureAppNetworkCmd (--internal) blocks egress ==="
# Drive the actual builder: it prints the network name + the exact create command.
APPNET=$(bun -e "import {appNetworkName} from './src/lib/services/app-network-utils'; process.stdout.write(appNetworkName('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))")
BUILDER_CMD=$(bun -e "import {buildEnsureAppNetworkCmd,appNetworkName} from './src/lib/services/app-network-utils'; process.stdout.write(buildEnsureAppNetworkCmd(appNetworkName('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')))")
echo "builder: $BUILDER_CMD"
sudo sh -c "$BUILDER_CMD"   # execute our real builder output as root
sudo docker network inspect "$APPNET" --format '{{.Internal}}' | grep -q true \
  && check ok "buildEnsureAppNetworkCmd created an --internal network" \
  || check fail "internal network flag"

# A container on the --internal net has NO egress (cannot reach the DB host nor internet).
OUT=$(sudo docker run --rm --network "$APPNET" "$IMG" sh -c "timeout 5 psql 'postgresql://x:y@${PG}:5432/z?sslmode=disable' -tAc 'select 1' 2>&1; echo EXIT=\$?" 2>&1)
echo "$OUT" | grep -qiE "could not translate host name|could not connect|no route|timeout|timed out|Name does not resolve|EXIT=[^0]" \
  && check ok "container on --internal net is EGRESS-BLOCKED (no route off-network)" \
  || check fail "internal egress block" "got: $(echo "$OUT" | head -1)"

echo
echo "=== $PASS passed, $FAIL failed ==="
exit $((FAIL>0 ? 1 : 0))

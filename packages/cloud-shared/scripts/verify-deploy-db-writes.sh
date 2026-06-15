#!/usr/bin/env bash
# Verify the apps deploy DB-orchestration adapters against the REAL drizzle schema
# on a throwaway, fully-migrated PGlite store (the team's local Postgres). Proves
# the container/job inserts + the per-tenant-DSN invariant for real, not mocked.
#
# Requires: bun. Run from packages/cloud-shared/.
set -uo pipefail

STORE="/tmp/apps-deploy-db-$$"
cleanup() { rm -rf "$STORE"; }
trap cleanup EXIT

echo "=== migrate the REAL schema into a throwaway PGlite store ==="
rm -rf "$STORE"; mkdir -p "$STORE"
DATABASE_URL="pglite://$STORE" bun run db:migrate 2>&1 | tail -2

echo
echo "=== run the adapter write-verification against the real schema ==="
DATABASE_URL="pglite://$STORE" \
  CONTAINERS_PUBLIC_BASE_DOMAIN="containers.elizacloud.ai" \
  bun run scripts/verify-deploy-db-writes.ts

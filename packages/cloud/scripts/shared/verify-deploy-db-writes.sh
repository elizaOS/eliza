#!/usr/bin/env bash
# Exercises the apps deploy adapters against a migrated, disposable PGlite store.
# Each invocation owns its store and stops before verification if migration fails.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../shared"
STORE="$(mktemp -d "${TMPDIR:-/tmp}/apps-deploy-db.XXXXXX")"
trap 'rm -rf -- "$STORE"' EXIT
export DATABASE_URL="pglite://$STORE"

bun run db:migrate
CONTAINERS_PUBLIC_BASE_DOMAIN="apps.eliza.app" \
  bun run ../scripts/shared/verify-deploy-db-writes.ts

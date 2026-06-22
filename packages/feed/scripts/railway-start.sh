#!/usr/bin/env bash
#
# Railway start command for the Feed web service.
#
# 1. Ensures the database schema is provisioned (auto-provision / "just works"):
#    the Feed Drizzle migration history has two parallel 0000_* baselines that
#    cannot be applied to a fresh database, so we derive the schema directly from
#    the canonical TypeScript schema with `drizzle-kit push`. It is idempotent —
#    a no-op when the schema is already in sync — and non-fatal on error so an
#    already-provisioned database still boots.
# 2. Boots the Next.js server (binds $PORT / 0.0.0.0).
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEED_DIR="$(dirname "$SCRIPT_DIR")" # packages/feed
cd "$FEED_DIR"

echo "[railway-start] Ensuring database schema (drizzle-kit push)..."
if (cd packages/db && bunx drizzle-kit push --config=drizzle.config.cjs --force); then
  echo "[railway-start] Schema ensured."
else
  echo "[railway-start] Schema push reported an issue; continuing (DB may already be provisioned)."
fi

echo "[railway-start] Starting Feed web server on port ${PORT:-3000}..."
exec bun run --cwd apps/web start

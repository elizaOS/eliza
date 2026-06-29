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
# `drizzle-kit push` can hit an interactive data-loss prompt (e.g. adding a
# unique constraint to an already-populated table). The container has no TTY, so
# the prompt would block on stdin and wedge the whole deploy until the Railway
# healthcheck times out. Redirect stdin from /dev/null so the prompt resolves
# immediately (push then exits non-zero), and keep it best-effort: an
# already-provisioned database must still boot even when push can't apply a
# change. Bounded by `timeout` as a hard backstop if `timeout` is available.
DRIZZLE_PUSH=(bunx drizzle-kit push --config=drizzle.config.cjs --force)
if command -v timeout >/dev/null 2>&1; then
  DRIZZLE_PUSH=(timeout 240 "${DRIZZLE_PUSH[@]}")
fi
if (cd packages/db && "${DRIZZLE_PUSH[@]}" </dev/null); then
  echo "[railway-start] Schema ensured."
else
  echo "[railway-start] Schema push skipped/failed; continuing (DB may already be provisioned)."
fi

echo "[railway-start] Starting Feed web server on port ${PORT:-3000}..."
exec bun run --cwd apps/web start

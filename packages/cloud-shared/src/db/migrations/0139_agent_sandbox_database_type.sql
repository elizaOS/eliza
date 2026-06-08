-- Database backend type and Electric Sync status for agent sandboxes.
--
-- database_type tracks which backend an agent uses:
-- - 'neon': shared Neon Postgres with RLS (legacy, the default for existing rows).
-- - 'pglite': per-agent PGlite with a persistent data directory.
-- - 'pglite_synced': per-agent PGlite synced from Electric Cloud.
--
-- database_sync_status tracks Electric Sync health for pglite_synced agents:
-- - 'synced': fully caught up with source-of-truth Postgres.
-- - 'syncing': sync is in progress (typically transitional).
-- - 'error': sync failed (see error_message for details).
--
-- Null database_type on legacy rows is treated as 'neon' by the runtime.
-- See packages/cloud-shared/src/lib/services/eliza-sandbox.ts.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "database_type" text,
  ADD COLUMN IF NOT EXISTS "database_sync_status" text;

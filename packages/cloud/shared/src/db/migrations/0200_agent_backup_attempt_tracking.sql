-- Backup sweep fairness + capability tracking (#15783 Phase 1).
--
-- `last_backup_at` is success-only (bumping it on a failed or skipped capture
-- would mask staleness), so a snapshot-incapable agent image — one that 404s
-- POST /api/snapshot (SNAPSHOT_ENDPOINT_UNSUPPORTED) — stays perpetually
-- "due" and permanently competes for the scheduled sweep's capped window,
-- nondeterministically starving backup-capable agents.
--
-- `last_backup_attempt_at` records every auto-snapshot attempt regardless of
-- outcome; `backup_unsupported_reason` marks rows whose image cannot serve a
-- snapshot so the sweep can re-probe them at a slow cadence instead of every
-- tick. Both are metadata-only nullable ADDs, safe on a hot table.
--
-- ensure-agent-sandbox-schema.ts carries the same ADD COLUMN IF NOT EXISTS
-- lines, so readers deployed ahead of this migration self-heal on first
-- repository access.
ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "last_backup_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "backup_unsupported_reason" text;

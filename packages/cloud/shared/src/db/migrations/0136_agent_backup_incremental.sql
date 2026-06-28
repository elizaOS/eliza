-- Incremental (diff) backups for managed agent sandboxes.
--
-- `backup_kind` distinguishes a full state snapshot from a delta against
-- `parent_backup_id`. Restoring an incremental backup replays its parent
-- chain back to the nearest full backup. `content_hash` is the sha256 of the
-- reconstructed full state, used to verify chain integrity. See
-- packages/cloud/shared/src/lib/services/agent-backup-diff.ts.

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "backup_kind" text NOT NULL DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS "parent_backup_id" uuid,
  ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_parent_idx"
  ON "agent_sandbox_backups" ("parent_backup_id");

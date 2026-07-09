-- Supports the backup restorability verifier's newest-backup-per-agent sampler:
-- DISTINCT ON (sandbox_record_id) ORDER BY sandbox_record_id, created_at DESC.
-- The verifier runs on the provisioning-worker infra cadence, so this prevents
-- each sweep from sorting the full backup history table as fleets grow.
CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_sandbox_latest_idx"
  ON "agent_sandbox_backups" ("sandbox_record_id", "created_at" DESC);

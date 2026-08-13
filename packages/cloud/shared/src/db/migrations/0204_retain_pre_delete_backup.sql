-- Retains one bounded, tenant-owned recovery point after an agent row is
-- deleted. The existing ON DELETE CASCADE remains in force for attached rows;
-- the delete transaction nulls only its exact pre-delete backup before deleting
-- the sandbox, so scheduled/manual/upgrade backups keep their current cascade.

ALTER TABLE "agent_sandbox_backups"
  ALTER COLUMN "sandbox_record_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "recovery_organization_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_agent_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_deletion_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_expires_at" timestamptz;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_recovery_organization_id_fkey"
    FOREIGN KEY ("recovery_organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "agent_sandbox_backups"
  ADD CONSTRAINT "agent_sandbox_backups_recovery_shape_check"
  CHECK ((
    "sandbox_record_id" IS NOT NULL
    AND "recovery_organization_id" IS NULL
    AND "recovery_agent_id" IS NULL
    AND "recovery_deletion_attempt_id" IS NULL
    AND "recovery_expires_at" IS NULL
  ) OR (
    "sandbox_record_id" IS NULL
    AND "snapshot_type" = 'pre-delete'
    AND "recovery_organization_id" IS NOT NULL
    AND "recovery_agent_id" IS NOT NULL
    AND "recovery_deletion_attempt_id" IS NOT NULL
    AND "recovery_expires_at" IS NOT NULL
  ));

CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_lookup_idx"
  ON "agent_sandbox_backups"
  ("recovery_organization_id", "recovery_agent_id", "created_at" DESC)
  WHERE "sandbox_record_id" IS NULL;

CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_expires_idx"
  ON "agent_sandbox_backups" ("recovery_expires_at")
  WHERE "sandbox_record_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_attempt_uidx"
  ON "agent_sandbox_backups"
  ("recovery_organization_id", "recovery_agent_id", "recovery_deletion_attempt_id")
  WHERE "sandbox_record_id" IS NULL;

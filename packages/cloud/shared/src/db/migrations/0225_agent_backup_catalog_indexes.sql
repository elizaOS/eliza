CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_backups_catalog_operation_uidx"
  ON "agent_sandbox_backups" ("catalog_organization_id", "catalog_agent_id", "backup_operation_id")
  WHERE "backup_operation_id" IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_catalog_identity_unique'
      AND conrelid = 'agent_sandbox_backups'::regclass
  ) THEN
    ALTER TABLE "agent_sandbox_backups"
      ADD CONSTRAINT "agent_sandbox_backups_catalog_identity_unique"
      UNIQUE ("id", "catalog_organization_id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_catalog_due_idx"
  ON "agent_sandbox_backups" ("catalog_next_attempt_at", "created_at")
  WHERE "catalog_state" IN (
    'scheduled', 'capturing', 'captured', 'uploading',
    'primary_uploaded', 'primary_verified', 'secondary_pending', 'failed_retryable'
  );
CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_base_idx"
  ON "agent_sandbox_backups" ("base_backup_id");

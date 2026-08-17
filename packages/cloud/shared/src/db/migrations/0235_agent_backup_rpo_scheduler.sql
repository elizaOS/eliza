-- DB-clock scheduler authority for the 15-minute backup RPO admission lane.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "next_backup_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "backup_schedule_operation_id" uuid,
  ADD COLUMN IF NOT EXISTS "backup_schedule_retry_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "backup_schedule_claim_owner" text,
  ADD COLUMN IF NOT EXISTS "backup_schedule_claim_generation" uuid,
  ADD COLUMN IF NOT EXISTS "backup_schedule_claim_expires_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "backup_schedule_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "backup_schedule_last_error_code" text,
  ADD COLUMN IF NOT EXISTS "backup_schedule_last_protected_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandboxes_backup_schedule_due_idx"
  ON "agent_sandboxes" ("next_backup_at", "backup_schedule_retry_at", "organization_id", "id")
  WHERE "next_backup_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandboxes_backup_schedule_claim_expiry_idx"
  ON "agent_sandboxes" ("backup_schedule_claim_expires_at")
  WHERE "backup_schedule_claim_expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandboxes_backup_schedule_operation_idx"
  ON "agent_sandboxes" ("organization_id", "id", "backup_schedule_operation_id")
  WHERE "backup_schedule_operation_id" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandboxes_backup_schedule_claim_shape_check'
      AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_backup_schedule_claim_shape_check" CHECK (((
        "backup_schedule_claim_owner" IS NULL
        AND "backup_schedule_claim_generation" IS NULL
        AND "backup_schedule_claim_expires_at" IS NULL
      ) OR (
        "next_backup_at" IS NOT NULL AND "backup_schedule_operation_id" IS NOT NULL
        AND "backup_schedule_claim_owner" IS NOT NULL
        AND "backup_schedule_claim_owner" <> ''
        AND "backup_schedule_claim_generation" IS NOT NULL
        AND "backup_schedule_claim_expires_at" IS NOT NULL
      )) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  VALIDATE CONSTRAINT "agent_sandboxes_backup_schedule_claim_shape_check";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandboxes_backup_schedule_attempts_check'
      AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_backup_schedule_attempts_check" CHECK ((
        "backup_schedule_attempts" >= 0
        AND ("backup_schedule_last_error_code" IS NULL
          OR "backup_schedule_last_error_code" ~ '^[A-Z][A-Z0-9_]{0,95}$')
      ) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  VALIDATE CONSTRAINT "agent_sandboxes_backup_schedule_attempts_check";
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_sandboxes_lifecycle_revision_trigger ON "agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
BEFORE UPDATE ON "agent_sandboxes" FOR EACH ROW WHEN (
  to_jsonb(OLD) - ARRAY[
    'billing_status', 'last_billed_at', 'hourly_rate', 'total_billed',
    'shutdown_warning_sent_at', 'scheduled_shutdown_at', 'updated_at',
    'next_backup_at', 'backup_schedule_operation_id', 'backup_schedule_retry_at',
    'backup_schedule_claim_owner', 'backup_schedule_claim_generation',
    'backup_schedule_claim_expires_at', 'backup_schedule_attempts',
    'backup_schedule_last_error_code', 'backup_schedule_last_protected_at'
  ]::text[] IS DISTINCT FROM to_jsonb(NEW) - ARRAY[
    'billing_status', 'last_billed_at', 'hourly_rate', 'total_billed',
    'shutdown_warning_sent_at', 'scheduled_shutdown_at', 'updated_at',
    'next_backup_at', 'backup_schedule_operation_id', 'backup_schedule_retry_at',
    'backup_schedule_claim_owner', 'backup_schedule_claim_generation',
    'backup_schedule_claim_expires_at', 'backup_schedule_attempts',
    'backup_schedule_last_error_code', 'backup_schedule_last_protected_at'
  ]::text[]
)
EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();

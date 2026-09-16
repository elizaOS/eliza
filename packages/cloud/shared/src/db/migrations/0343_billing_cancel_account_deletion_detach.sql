-- Preserve billing-cancel evidence while independently removing subject references.

ALTER TABLE "billing_cancel_commands"
  ALTER COLUMN "organization_id" DROP NOT NULL,
  ALTER COLUMN "requested_by_user_id" DROP NOT NULL,
  ALTER COLUMN "job_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "organization_deletion_request_id" uuid,
  ADD COLUMN IF NOT EXISTS "requesting_user_deletion_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys"
  ALTER COLUMN "organization_id" DROP NOT NULL,
  ALTER COLUMN "requested_by_user_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "organization_deletion_request_id" uuid,
  ADD COLUMN IF NOT EXISTS "requesting_user_deletion_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" DROP CONSTRAINT IF EXISTS "billing_cancel_commands_shape_check";
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_shape_check"
  CHECK ("resource_type" IN ('container', 'agent_sandbox') AND "action" = 'stop'
    AND "expected_lifecycle_revision" >= 0
    AND (("organization_id" IS NOT NULL AND "job_id" IS NOT NULL
      AND "organization_deletion_request_id" IS NULL)
    OR ("organization_id" IS NULL AND "job_id" IS NULL
      AND "organization_deletion_request_id" IS NOT NULL))
    AND (("requested_by_user_id" IS NOT NULL AND "requesting_user_deletion_request_id" IS NULL)
    OR ("requested_by_user_id" IS NULL
      AND "requesting_user_deletion_request_id" IS NOT NULL))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" VALIDATE CONSTRAINT "billing_cancel_commands_shape_check";
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys"
  DROP CONSTRAINT IF EXISTS "billing_cancel_command_keys_digest_shape_check";
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_digest_shape_check"
  CHECK ("idempotency_key_hash" ~ '^[a-f0-9]{64}$' AND "request_digest" ~ '^[a-f0-9]{64}$'
    AND (("organization_id" IS NOT NULL AND "organization_deletion_request_id" IS NULL)
    OR ("organization_id" IS NULL AND "organization_deletion_request_id" IS NOT NULL))
    AND (("requested_by_user_id" IS NOT NULL AND "requesting_user_deletion_request_id" IS NULL)
    OR ("requested_by_user_id" IS NULL
      AND "requesting_user_deletion_request_id" IS NOT NULL))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys"
  VALIDATE CONSTRAINT "billing_cancel_command_keys_digest_shape_check";
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT
  "billing_cancel_commands_org_deletion_request_fk" FOREIGN KEY ("organization_deletion_request_id")
  REFERENCES "account_deletion_requests"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" VALIDATE CONSTRAINT "billing_cancel_commands_org_deletion_request_fk";
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT
  "billing_cancel_commands_user_deletion_request_fk" FOREIGN KEY ("requesting_user_deletion_request_id")
  REFERENCES "account_deletion_requests"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" VALIDATE CONSTRAINT "billing_cancel_commands_user_deletion_request_fk";
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT
  "billing_cancel_command_keys_org_deletion_request_fk" FOREIGN KEY ("organization_deletion_request_id")
  REFERENCES "account_deletion_requests"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" VALIDATE CONSTRAINT "billing_cancel_command_keys_org_deletion_request_fk";
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT
  "billing_cancel_command_keys_user_deletion_request_fk" FOREIGN KEY ("requesting_user_deletion_request_id")
  REFERENCES "account_deletion_requests"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" VALIDATE CONSTRAINT "billing_cancel_command_keys_user_deletion_request_fk";
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT
  "billing_cancel_command_keys_command_id_commands_id_fk" FOREIGN KEY ("command_id")
  REFERENCES "billing_cancel_commands"("id") ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys"
  VALIDATE CONSTRAINT "billing_cancel_command_keys_command_id_commands_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_commands_active_requesting_user_idx"
  ON "billing_cancel_commands" ("requested_by_user_id") WHERE "requested_by_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_command_keys_active_requesting_user_idx"
  ON "billing_cancel_command_keys" ("requested_by_user_id") WHERE "requested_by_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_commands_org_deletion_request_idx"
  ON "billing_cancel_commands" ("organization_deletion_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_commands_user_deletion_request_idx"
  ON "billing_cancel_commands" ("requesting_user_deletion_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_command_keys_org_deletion_request_idx"
  ON "billing_cancel_command_keys" ("organization_deletion_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_command_keys_user_deletion_request_idx"
  ON "billing_cancel_command_keys" ("requesting_user_deletion_request_id");

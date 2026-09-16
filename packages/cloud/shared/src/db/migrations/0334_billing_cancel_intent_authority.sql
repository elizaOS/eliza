-- Add explicit user-stop authority and durable retained-backup billing facts.

ALTER TABLE "container_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "authorization" text DEFAULT 'billing_request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "container_compute_stop_intents"
  ADD CONSTRAINT "container_compute_stop_intents_authorization_check"
  CHECK ("authorization" IN ('billing_request', 'user_request'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "container_compute_stop_intents_user_generation_unique"
  ON "container_compute_stop_intents" ("organization_id", "container_id", "lifecycle_revision")
  WHERE "authorization" = 'user_request';
--> statement-breakpoint
ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "authorization" text DEFAULT 'billing_request' NOT NULL,
  ADD COLUMN IF NOT EXISTS "retained_backup_billing" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "retained_backup_rate_per_hour" numeric(18, 6);
--> statement-breakpoint
ALTER TABLE "agent_compute_stop_intents"
  ADD CONSTRAINT "agent_compute_stop_intents_authorization_check"
  CHECK ("authorization" IN ('billing_request', 'user_request')),
  ADD CONSTRAINT "agent_compute_stop_intents_retained_backup_billing_check"
  CHECK (("retained_backup_billing" = true AND "retained_backup_rate_per_hour" > 0)
    OR ("retained_backup_billing" = false AND "retained_backup_rate_per_hour" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_stop_intents_user_request_unique"
  ON "agent_compute_stop_intents" ("organization_id", "agent_id", "lifecycle_revision")
  WHERE "authorization" = 'user_request';

-- Add billing tracking columns to milady_sandboxes table.
-- Mirrors the billing fields on the `containers` table so the new
-- milady-billing cron can track per-agent charges, warnings, and shutdowns.

ALTER TABLE "milady_sandboxes"
  ADD COLUMN IF NOT EXISTS "billing_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "last_billed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "hourly_rate" numeric(10,4) DEFAULT '0.0200',
  ADD COLUMN IF NOT EXISTS "total_billed" numeric(10,2) NOT NULL DEFAULT '0.00',
  ADD COLUMN IF NOT EXISTS "shutdown_warning_sent_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "scheduled_shutdown_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "milady_sandboxes_billing_status_idx"
  ON "milady_sandboxes" ("billing_status");

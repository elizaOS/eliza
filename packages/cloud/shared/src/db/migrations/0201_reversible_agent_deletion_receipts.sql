-- Preserve the exact lifecycle and billing state a cancellable deletion replaces.
-- Legacy in-flight deletions remain NULL and are intentionally non-reversible.
ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "deletion_previous_status" text,
  ADD COLUMN IF NOT EXISTS "deletion_previous_billing_status" text,
  ADD COLUMN IF NOT EXISTS "deletion_previous_shutdown_warning_sent_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "deletion_previous_scheduled_shutdown_at" timestamptz;

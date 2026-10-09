-- Entitlement-driven Dedicated-to-Shared transitions (#25146). A lapsed paid
-- plan (payment failed past grace, or ended/canceled at period end) withdraws
-- Dedicated access through the same durable interval row as a confirmed
-- unfunded billing stop. Every transition advances a revision fence; the row
-- records the entitlement projection revision it acted on, the preserved
-- runtime's retention deadline, the suspend/resume effects and the receipt of
-- the Shared interval reconciled back into Dedicated.
ALTER TABLE "personal_dedicated_fallbacks" ALTER COLUMN "stop_intent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks"
  ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "entitlement_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_entitlement_revision" bigint,
  ADD COLUMN IF NOT EXISTS "retain_until" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "suspend_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "resume_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_requested_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reconciled_message_count" integer,
  ADD COLUMN IF NOT EXISTS "reconciled_inserted_count" integer;
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_state_check";
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_state_check"
  CHECK (("state" IN ('fallback_pending', 'shared_active') AND "recovered_at" IS NULL AND "recovery_requested_at" IS NULL)
    OR ("state" = 'recovery_pending' AND "recovered_at" IS NULL AND "recovery_requested_at" IS NOT NULL)
    OR ("state" = 'recovered' AND "recovered_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_reason_check";
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_reason_check"
  CHECK (("reason" = 'billing_suspended' AND "stop_intent_id" IS NOT NULL)
    OR ("reason" IN ('subscription_payment_failed', 'subscription_ended')
      AND "entitlement_revision" IS NOT NULL AND "retain_until" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_revision_check";
--> statement-breakpoint
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_revision_check"
  CHECK ("revision" >= 1
    AND ("reconciled_message_count" IS NULL OR "reconciled_message_count" >= 0)
    AND ("reconciled_inserted_count" IS NULL OR "reconciled_inserted_count" >= 0));
--> statement-breakpoint
DROP INDEX IF EXISTS "personal_dedicated_fallbacks_active_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_open_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id")
  WHERE "state" <> 'recovered';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_open_dedicated_idx"
  ON "personal_dedicated_fallbacks" ("dedicated_agent_id", "state")
  WHERE "state" <> 'recovered';

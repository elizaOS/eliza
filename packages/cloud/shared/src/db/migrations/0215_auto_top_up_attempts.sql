CREATE TABLE IF NOT EXISTS "auto_top_up_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "trigger_source" text NOT NULL,
  "status" text DEFAULT 'claimed' NOT NULL,
  "credit_amount_cents" bigint NOT NULL,
  "charge_amount_cents" bigint NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "stripe_customer_id_snapshot" text NOT NULL,
  "stripe_payment_method_id_snapshot" text NOT NULL,
  "request_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "stripe_payment_intent_id" text,
  "credit_transaction_id" uuid REFERENCES "credit_transactions"("id"),
  "covered_balance_decrease_revision" bigint,
  "provider_status" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now(),
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "provider_request_started_at" timestamp with time zone,
  "recovery_deadline_at" timestamp with time zone,
  "last_error" text,
  "result" jsonb,
  "payment_succeeded_at" timestamp with time zone,
  "credited_at" timestamp with time zone,
  "canceled_at" timestamp with time zone,
  "manual_review_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auto_top_up_attempts_trigger_source_check"
    CHECK ("trigger_source" IN ('cron','credit_deduction','manual','recovery')),
  CONSTRAINT "auto_top_up_attempts_status_check"
    CHECK ("status" IN ('claimed','payment_pending','payment_succeeded','credited','canceled','manual_review')),
  CONSTRAINT "auto_top_up_attempts_amount_check"
    CHECK ("credit_amount_cents" BETWEEN 100 AND 100000
      AND "charge_amount_cents" BETWEEN "credit_amount_cents" AND 1120000),
  CONSTRAINT "auto_top_up_attempts_currency_check" CHECK ("currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "auto_top_up_attempts_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "auto_top_up_attempts_lease_pair_check"
    CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "auto_top_up_attempts_provider_window_check"
    CHECK ((("provider_request_started_at" IS NULL) = ("recovery_deadline_at" IS NULL))
      AND ("recovery_deadline_at" IS NULL OR "recovery_deadline_at" > "provider_request_started_at")),
  CONSTRAINT "auto_top_up_attempts_terminal_check"
    CHECK ("status" NOT IN ('credited','canceled','manual_review')
      OR ("lease_token" IS NULL AND "next_attempt_at" IS NULL)),
  CONSTRAINT "auto_top_up_attempts_succeeded_check"
    CHECK ("status" NOT IN ('payment_succeeded','credited')
      OR ("stripe_payment_intent_id" IS NOT NULL AND "payment_succeeded_at" IS NOT NULL)),
  CONSTRAINT "auto_top_up_attempts_canceled_check"
    CHECK ("status" <> 'canceled' OR ("provider_request_started_at" IS NULL
        AND "stripe_payment_intent_id" IS NULL)
      OR ("stripe_payment_intent_id" IS NOT NULL AND "provider_status" = 'canceled')),
  CONSTRAINT "auto_top_up_attempts_credited_check"
    CHECK ("status" <> 'credited' OR ("credit_transaction_id" IS NOT NULL
      AND "covered_balance_decrease_revision" IS NOT NULL AND "credited_at" IS NOT NULL)),
  CONSTRAINT "auto_top_up_attempts_covered_revision_check"
    CHECK ("covered_balance_decrease_revision" IS NULL OR "covered_balance_decrease_revision" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "auto_top_up_attempts_idempotency_key_idx"
  ON "auto_top_up_attempts" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "auto_top_up_attempts_payment_intent_idx"
  ON "auto_top_up_attempts" ("stripe_payment_intent_id") WHERE "stripe_payment_intent_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "auto_top_up_attempts_blocking_org_idx"
  ON "auto_top_up_attempts" ("organization_id")
  WHERE "status" IN ('claimed','payment_pending','payment_succeeded','manual_review');
CREATE INDEX IF NOT EXISTS "auto_top_up_attempts_due_idx"
  ON "auto_top_up_attempts" ("next_attempt_at", "lease_expires_at")
  WHERE "status" IN ('claimed','payment_pending','payment_succeeded') AND "next_attempt_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "auto_top_up_attempts_org_created_idx"
  ON "auto_top_up_attempts" ("organization_id", "created_at");

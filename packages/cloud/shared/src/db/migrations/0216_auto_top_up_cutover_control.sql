-- Singleton cutover authority: no executable legacy mode exists.
CREATE TABLE IF NOT EXISTS "auto_top_up_control" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "mode" text DEFAULT 'paused' NOT NULL,
  "paused_at" timestamp with time zone DEFAULT now() NOT NULL,
  "legacy_reconciled_through" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auto_top_up_control_singleton_check" CHECK ("singleton" = true),
  CONSTRAINT "auto_top_up_control_mode_check" CHECK ("mode" IN ('paused','durable')),
  CONSTRAINT "auto_top_up_control_reconciliation_check"
    CHECK ("legacy_reconciled_through" IS NULL OR "legacy_reconciled_through" >= "paused_at")
);
INSERT INTO "auto_top_up_control" ("singleton", "mode") VALUES (true, 'paused')
ON CONFLICT ("singleton") DO NOTHING;

-- Reconciliation-only quarantine; this table never initiates Stripe.
CREATE TABLE IF NOT EXISTS "auto_top_up_legacy_payment_quarantine" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "stripe_payment_intent_id" text NOT NULL,
  "provider_status" text NOT NULL,
  "credit_amount_cents" bigint NOT NULL,
  "status" text DEFAULT 'unresolved' NOT NULL,
  "credit_transaction_id" uuid REFERENCES "credit_transactions"("id"),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auto_top_up_legacy_quarantine_status_check"
    CHECK ("status" IN ('unresolved','credited','canceled','manual_review')),
  CONSTRAINT "auto_top_up_legacy_quarantine_resolution_check"
    CHECK (("status" IN ('credited','canceled')) = ("resolved_at" IS NOT NULL)
      AND (("status" = 'credited') = ("credit_transaction_id" IS NOT NULL))
      AND ("status" <> 'credited' OR "provider_status" = 'succeeded')
      AND ("status" <> 'canceled' OR "provider_status" = 'canceled')),
  CONSTRAINT "auto_top_up_legacy_quarantine_amount_check" CHECK ("credit_amount_cents" BETWEEN 100 AND 100000)
);
CREATE UNIQUE INDEX IF NOT EXISTS "auto_top_up_legacy_quarantine_pi_idx"
  ON "auto_top_up_legacy_payment_quarantine" ("stripe_payment_intent_id");
CREATE INDEX IF NOT EXISTS "auto_top_up_legacy_quarantine_org_status_idx"
  ON "auto_top_up_legacy_payment_quarantine" ("organization_id", "status");

-- A lost chargeback is a final payment reversal. It places a durable
-- organization hold that fails new paid admission closed until an explicit,
-- audited release.
CREATE TABLE IF NOT EXISTS "organization_payment_reversal_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "stripe_dispute_id" text NOT NULL,
  "stripe_charge_id" text,
  "stripe_payment_intent_id" text,
  "amount_cents" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone,
  "released_by" text,
  "release_reason" text,
  CONSTRAINT "organization_payment_reversal_holds_reason_check"
    CHECK ("reason" IN ('chargeback_lost')),
  CONSTRAINT "organization_payment_reversal_holds_release_shape_check"
    CHECK (("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL)
      OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_payment_reversal_holds_dispute_unique"
  ON "organization_payment_reversal_holds" ("stripe_dispute_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_payment_reversal_holds_active_idx"
  ON "organization_payment_reversal_holds" ("organization_id")
  WHERE "released_at" IS NULL;

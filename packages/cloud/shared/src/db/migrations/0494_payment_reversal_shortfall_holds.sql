-- #22930 Decision A: a Stripe reversal (refund or dispute clawback) that leaves
-- an unrecovered shortfall places a billing hold carrying that outstanding
-- amount. It clears on dispute reinstatement or once repayment covers it.
-- A lost dispute alone no longer holds an organization that owes nothing.
ALTER TABLE "organization_payment_reversal_holds" ALTER COLUMN "stripe_dispute_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "clawback_transaction_id" uuid REFERENCES "credit_transactions"("id");
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "shortfall_usd" numeric(16, 6);
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "outstanding_usd" numeric(16, 6);
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" DROP CONSTRAINT IF EXISTS "organization_payment_reversal_holds_reason_check";
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" ADD CONSTRAINT "organization_payment_reversal_holds_reason_check"
  CHECK ("reason" IN ('chargeback_lost', 'reversal_shortfall'));
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" DROP CONSTRAINT IF EXISTS "organization_payment_reversal_holds_source_shape_check";
--> statement-breakpoint
ALTER TABLE "organization_payment_reversal_holds" ADD CONSTRAINT "organization_payment_reversal_holds_source_shape_check"
  CHECK (
    ("reason" = 'chargeback_lost' AND "stripe_dispute_id" IS NOT NULL
      AND "clawback_transaction_id" IS NULL AND "shortfall_usd" IS NULL AND "outstanding_usd" IS NULL)
    OR ("reason" = 'reversal_shortfall' AND "clawback_transaction_id" IS NOT NULL
      AND "shortfall_usd" > 0 AND "outstanding_usd" >= 0 AND "outstanding_usd" <= "shortfall_usd")
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_payment_reversal_holds_clawback_unique"
  ON "organization_payment_reversal_holds" ("clawback_transaction_id");
--> statement-breakpoint
-- Carry a still-owed lost-dispute shortfall into the new hold before the
-- superseded lost-dispute hold is released, so no unpaid debt is dropped.
INSERT INTO "organization_payment_reversal_holds" (
  "organization_id", "reason", "clawback_transaction_id", "shortfall_usd", "outstanding_usd",
  "stripe_charge_id", "stripe_payment_intent_id", "amount_cents"
)
SELECT
  hold."organization_id", 'reversal_shortfall', clawback."id",
  (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6),
  (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6),
  hold."stripe_charge_id", hold."stripe_payment_intent_id", hold."amount_cents"
FROM "organization_payment_reversal_holds" AS hold
JOIN "credit_transactions" AS clawback
  ON clawback."stripe_payment_intent_id" = 'stripe:dispute:' || hold."stripe_dispute_id"
  AND clawback."type" = 'clawback'
  AND clawback."organization_id" = hold."organization_id"
WHERE hold."reason" = 'chargeback_lost'
  AND hold."released_at" IS NULL
  AND clawback."metadata"->>'unrecovered_clawback_usd' ~ '^[0-9]+(\.[0-9]+)?$'
  AND (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6) > 0
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "organization_payment_reversal_holds"
SET "released_at" = now(),
  "released_by" = 'migration:0494_payment_reversal_shortfall_holds',
  "release_reason" = 'Superseded by the ratified reversal-shortfall billing hold (#22930 Decision A)'
WHERE "reason" = 'chargeback_lost' AND "released_at" IS NULL;

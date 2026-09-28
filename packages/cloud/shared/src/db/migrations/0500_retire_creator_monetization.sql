-- #22961 / #23022: creator monetization is retired (owner decision, see #22957).
-- Cloud billing is subscription (Plus/Pro) plus pay-as-you-go; creators no
-- longer accrue earnings and every creator payout rail is closed. The
-- affiliate program continues: affiliate earnings credited after the
-- retirement instant remain payable through the affiliate-only payout path.
--
-- This migration never deletes or rewrites ledger history. It:
--   1. records every user's unpaid creator balance as a frozen, read-only
--      statement row (available + pending at retirement time);
--   2. stops earnings from silently funding hosting (the pay-as-you-go
--      conversion was an automatic payout of the frozen balance);
--   3. disables agent and app creator monetization (inference markup and
--      purchase share) so buyers stop paying a creator surcharge that no
--      longer accrues to anyone.
-- Frozen balances are settled manually by an operator; nothing here pays out.
-- The retirement instant. Affiliate earnings credited after it stay payable
-- through the affiliate-only payout path; everything before it is frozen.
CREATE TABLE IF NOT EXISTS "creator_monetization_retirement" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "retired_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creator_monetization_retirement_singleton_check" CHECK ("id")
);
--> statement-breakpoint
INSERT INTO "creator_monetization_retirement" ("id", "retired_at")
VALUES (true, now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creator_earnings_retirement_statements" (
  -- No foreign keys: the liability record must outlive account deletion.
  "user_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid,
  "status" text DEFAULT 'frozen' NOT NULL,
  "total_earned_usd" numeric(18, 4) NOT NULL,
  "total_redeemed_usd" numeric(18, 4) NOT NULL,
  "total_converted_to_credits_usd" numeric(18, 4) NOT NULL,
  "available_balance_usd" numeric(18, 4) NOT NULL,
  "pending_redemption_usd" numeric(18, 4) NOT NULL,
  "unpaid_balance_usd" numeric(18, 4) NOT NULL,
  "earned_from_apps_usd" numeric(18, 4) NOT NULL,
  "earned_from_agents_usd" numeric(18, 4) NOT NULL,
  "earned_from_mcps_usd" numeric(18, 4) NOT NULL,
  "earned_from_affiliates_usd" numeric(18, 4) NOT NULL,
  "earned_from_revenue_shares_usd" numeric(18, 4) NOT NULL,
  "frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "settlement_reference" text,
  CONSTRAINT "creator_earnings_retirement_statements_status_check"
    CHECK (("status" = 'frozen' AND "settled_at" IS NULL AND "settlement_reference" IS NULL)
      OR ("status" = 'settled_manually' AND "settled_at" IS NOT NULL AND "settlement_reference" IS NOT NULL)),
  CONSTRAINT "creator_earnings_retirement_statements_amounts_check"
    CHECK ("available_balance_usd" >= 0 AND "pending_redemption_usd" >= 0
      AND "unpaid_balance_usd" = "available_balance_usd" + "pending_redemption_usd"
      AND "unpaid_balance_usd" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creator_earnings_retirement_statements_org_idx"
  ON "creator_earnings_retirement_statements" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "creator_earnings_retirement_statements_frozen_idx"
  ON "creator_earnings_retirement_statements" ("status")
  WHERE "status" = 'frozen';
--> statement-breakpoint
INSERT INTO "creator_earnings_retirement_statements" (
  "user_id",
  "organization_id",
  "total_earned_usd",
  "total_redeemed_usd",
  "total_converted_to_credits_usd",
  "available_balance_usd",
  "pending_redemption_usd",
  "unpaid_balance_usd",
  "earned_from_apps_usd",
  "earned_from_agents_usd",
  "earned_from_mcps_usd",
  "earned_from_affiliates_usd",
  "earned_from_revenue_shares_usd"
)
SELECT
  earnings."user_id",
  account."organization_id",
  earnings."total_earned",
  earnings."total_redeemed",
  earnings."total_converted_to_credits",
  earnings."available_balance",
  earnings."total_pending",
  earnings."available_balance" + earnings."total_pending",
  earnings."earned_from_miniapps",
  earnings."earned_from_agents",
  earnings."earned_from_mcps",
  earnings."earned_from_affiliates",
  earnings."earned_from_app_owner_shares" + earnings."earned_from_creator_shares"
FROM "redeemable_earnings" AS earnings
JOIN "users" AS account ON account."id" = earnings."user_id"
WHERE earnings."available_balance" + earnings."total_pending" > 0
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
UPDATE "organizations"
  SET "pay_as_you_go_from_earnings" = false
  WHERE "pay_as_you_go_from_earnings" = true;
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "pay_as_you_go_from_earnings" SET DEFAULT false;
--> statement-breakpoint
UPDATE "user_characters"
  SET "monetization_enabled" = false
  WHERE "monetization_enabled" = true;
--> statement-breakpoint
UPDATE "apps"
  SET "monetization_enabled" = false
  WHERE "monetization_enabled" = true;

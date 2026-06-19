-- Earnings auto-fund: let creators top up their org credit balance from
-- their own redeemable app earnings, with a "keep this much for cashout"
-- floor so the loop doesn't drain the redeemable pool.
--
-- Schema-only — the matching `credit_conversion` enum value lives in
-- 0071 so this migration stays purely additive (no enum changes mixed
-- with column changes; safer to roll back individually if needed).

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "auto_fund_from_earnings_enabled" boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS "auto_fund_from_earnings_threshold" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "auto_fund_from_earnings_amount" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "auto_fund_keep_balance" numeric(10, 2) DEFAULT '0.00';

-- Track total earnings ever converted into org credits (separate from
-- token redemptions so cashout vs. self-funded-hosting stay distinct in
-- creator-facing stats).
ALTER TABLE "redeemable_earnings"
  ADD COLUMN IF NOT EXISTS "total_converted_to_credits" numeric(18, 4) NOT NULL DEFAULT '0.0000';

CREATE INDEX IF NOT EXISTS "organizations_auto_fund_from_earnings_idx"
  ON "organizations" ("auto_fund_from_earnings_enabled")
  WHERE "auto_fund_from_earnings_enabled" = true;

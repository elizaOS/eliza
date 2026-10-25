-- Drop the earnings auto-fund settings columns introduced in 0070.
--
-- Replaced with a simpler design: container daily-billing now debits
-- the owner's redeemable_earnings before falling through to org
-- credits. Pay-as-you-go, no settings, no thresholds. The creator
-- cashes out whenever they want via the existing redeem flow.
--
-- We keep `total_converted_to_credits` on redeemable_earnings and the
-- `credit_conversion` ledger entry type — both still record the
-- earnings → credits flow that container billing now uses internally.

DROP INDEX IF EXISTS "organizations_auto_fund_from_earnings_idx";

ALTER TABLE "organizations"
  DROP COLUMN IF EXISTS "auto_fund_from_earnings_enabled",
  DROP COLUMN IF EXISTS "auto_fund_from_earnings_threshold",
  DROP COLUMN IF EXISTS "auto_fund_from_earnings_amount",
  DROP COLUMN IF EXISTS "auto_fund_keep_balance";

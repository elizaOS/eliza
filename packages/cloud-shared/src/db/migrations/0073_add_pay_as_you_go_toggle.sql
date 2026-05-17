-- Optional toggle: when true (default), container daily-billing debits
-- redeemable_earnings before falling through to credit_balance. When
-- false, hosting bills come purely from credits and earnings are
-- preserved for token cashout. UI lives at /dashboard/billing.

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "pay_as_you_go_from_earnings" boolean DEFAULT true NOT NULL;

-- Default new organizations to $0.00 credit (was $100.000000).
--
-- The $100 default was a give-away footgun: any organization row created outside
-- the signup path silently started with $100 of free credit. The signup path
-- (steward-sync.ts) sets credit_balance explicitly and grants DEFAULT_INITIAL_CREDITS
-- ($5), so it does not depend on this default — this change only affects non-signup
-- creation paths, which should start at $0. Existing balances are untouched.
ALTER TABLE "organizations" ALTER COLUMN "credit_balance" SET DEFAULT '0.000000';

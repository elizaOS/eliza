-- Fix floating point precision issues for monetization earnings
-- Increase scale from 2 to 6 decimal places for accurate micro-transaction tracking

-- Update app_earnings table
ALTER TABLE app_earnings
  ALTER COLUMN total_lifetime_earnings TYPE numeric(12, 6),
  ALTER COLUMN total_inference_earnings TYPE numeric(12, 6),
  ALTER COLUMN total_purchase_earnings TYPE numeric(12, 6),
  ALTER COLUMN pending_balance TYPE numeric(12, 6),
  ALTER COLUMN withdrawable_balance TYPE numeric(12, 6),
  ALTER COLUMN total_withdrawn TYPE numeric(12, 6);

-- Update app_earnings_transactions table
ALTER TABLE app_earnings_transactions
  ALTER COLUMN amount TYPE numeric(10, 6);

-- Update apps table
ALTER TABLE apps
  ALTER COLUMN total_creator_earnings TYPE numeric(12, 6),
  ALTER COLUMN total_platform_revenue TYPE numeric(12, 6);

-- Update default payout threshold from $10 to $25
-- This migration updates existing app_earnings records that still have the old default

-- Update existing records with the old $10.00 threshold to the new $25.00 threshold
UPDATE app_earnings 
SET payout_threshold = '25.00' 
WHERE payout_threshold = '10.00';

-- Note: The schema default has been updated in the code.
-- New records will automatically get the $25.00 default.

-- Ad spend requires operator approval (#11364).
--
-- Existing accounts keep their explicit status. New ad-account rows default to
-- pending so any raw insert path fails closed until an admin approves it.
ALTER TABLE "ad_accounts" ALTER COLUMN "status" SET DEFAULT 'pending';

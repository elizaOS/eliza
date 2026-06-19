-- Rollback: Remove granularTimeframe column from TimeframedMarket table

-- Drop the index first
DROP INDEX IF EXISTS "TimeframedMarket_granularTimeframe_idx";

-- Remove the column
ALTER TABLE "TimeframedMarket" DROP COLUMN IF EXISTS "granularTimeframe";

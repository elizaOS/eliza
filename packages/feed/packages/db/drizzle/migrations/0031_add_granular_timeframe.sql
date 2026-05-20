-- Migration: Add granularTimeframe column to TimeframedMarket table
-- This stores the precise market duration key ('15m', '30m', '1h', etc.)
-- instead of inferring it from duration, preventing misclassification at boundaries

-- Add the granularTimeframe column (nullable for backward compatibility with existing markets)
ALTER TABLE "TimeframedMarket" ADD COLUMN IF NOT EXISTS "granularTimeframe" TEXT;

-- Create index for efficient querying by granular timeframe
CREATE INDEX IF NOT EXISTS "TimeframedMarket_granularTimeframe_idx" ON "TimeframedMarket" ("granularTimeframe");

-- PRE-MIGRATION CHECK: Identify markets with durations that don't match any known timeframe
-- These will be left as NULL after the backfill and should be investigated
DO $$
DECLARE
    unmatched_count INTEGER;
    unmatched_records TEXT;
BEGIN
    SELECT COUNT(*) INTO unmatched_count
    FROM "TimeframedMarket"
    WHERE "granularTimeframe" IS NULL
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 810000 AND 990000      -- not 15m
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 1620000 AND 1980000    -- not 30m
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 3240000 AND 3960000    -- not 1h
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 19440000 AND 23760000  -- not 6h
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 38880000 AND 47520000  -- not 12h
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 77760000 AND 95040000  -- not 1d
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 155520000 AND 190080000 -- not 2d
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 233280000 AND 285120000; -- not 3d

    IF unmatched_count > 0 THEN
        -- Get sample of unmatched records for logging
        SELECT string_agg(
            'id=' || id || ', duration_ms=' || ROUND(EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000)::TEXT,
            '; '
        ) INTO unmatched_records
        FROM (
            SELECT id, "startTime", "endTime"
            FROM "TimeframedMarket"
            WHERE "granularTimeframe" IS NULL
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 810000 AND 990000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 1620000 AND 1980000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 3240000 AND 3960000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 19440000 AND 23760000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 38880000 AND 47520000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 77760000 AND 95040000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 155520000 AND 190080000
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 233280000 AND 285120000
            LIMIT 10
        ) sample;

        RAISE WARNING '[MIGRATION 0031] Found % markets with unrecognized durations that will have NULL granularTimeframe. Sample: %', unmatched_count, unmatched_records;
    END IF;
END $$;

-- Backfill existing markets based on their duration
-- Maps duration to granular timeframe keys using the same logic as inferGranularTimeframe()
-- IMPORTANT: Unknown durations are set to NULL (not silently defaulted) to surface data anomalies
UPDATE "TimeframedMarket"
SET "granularTimeframe" = CASE
    -- 15 minute markets (±10% tolerance: 810000ms - 990000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 810000 AND 990000 THEN '15m'
    -- 30 minute markets (±10% tolerance: 1620000ms - 1980000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 1620000 AND 1980000 THEN '30m'
    -- 1 hour markets (±10% tolerance: 3240000ms - 3960000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 3240000 AND 3960000 THEN '1h'
    -- 6 hour markets (±10% tolerance: 19440000ms - 23760000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 19440000 AND 23760000 THEN '6h'
    -- 12 hour markets (±10% tolerance: 38880000ms - 47520000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 38880000 AND 47520000 THEN '12h'
    -- 1 day markets (±10% tolerance: 77760000ms - 95040000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 77760000 AND 95040000 THEN '1d'
    -- 2 day markets (±10% tolerance: 155520000ms - 190080000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 155520000 AND 190080000 THEN '2d'
    -- 3 day markets (±10% tolerance: 233280000ms - 285120000ms)
    WHEN EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 BETWEEN 233280000 AND 285120000 THEN '3d'
    -- Unknown durations: leave as NULL to surface anomalies (do NOT silently default to '1h')
    ELSE NULL
END
WHERE "granularTimeframe" IS NULL;

-- POST-MIGRATION CHECK: Verify no records were incorrectly assigned '1h' with non-1h durations
-- This catches any edge cases or data corruption
DO $$
DECLARE
    misassigned_count INTEGER;
    misassigned_records TEXT;
BEGIN
    SELECT COUNT(*) INTO misassigned_count
    FROM "TimeframedMarket"
    WHERE "granularTimeframe" = '1h'
      AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 3240000 AND 3960000;

    IF misassigned_count > 0 THEN
        -- Get sample of misassigned records for logging
        SELECT string_agg(
            'id=' || id || ', duration_ms=' || ROUND(EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000)::TEXT,
            '; '
        ) INTO misassigned_records
        FROM (
            SELECT id, "startTime", "endTime"
            FROM "TimeframedMarket"
            WHERE "granularTimeframe" = '1h'
              AND EXTRACT(EPOCH FROM ("endTime" - "startTime")) * 1000 NOT BETWEEN 3240000 AND 3960000
            LIMIT 10
        ) sample;

        RAISE EXCEPTION '[MIGRATION 0031] CRITICAL: Found % markets with granularTimeframe=''1h'' but duration outside 1h range (3240000-3960000ms). These records need investigation before proceeding. Sample: %', misassigned_count, misassigned_records;
    END IF;
END $$;

-- POST-MIGRATION INFO: Log count of NULL granularTimeframe records for visibility
DO $$
DECLARE
    null_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO null_count
    FROM "TimeframedMarket"
    WHERE "granularTimeframe" IS NULL;

    IF null_count > 0 THEN
        RAISE WARNING '[MIGRATION 0031] % markets have NULL granularTimeframe (unrecognized duration). These should be investigated and manually assigned.', null_count;
    ELSE
        RAISE NOTICE '[MIGRATION 0031] All markets successfully assigned a granularTimeframe.';
    END IF;
END $$;

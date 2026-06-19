-- Rollback Migration: Remove range partitioning from Posts and Comments tables
-- 
-- This migration reverses the partitioning changes and restores the original tables.
-- 
-- IMPORTANT: This rollback should only be run if:
-- 1. The partitioned tables haven't been made primary yet (table swap not done)
-- 2. Or if you're prepared to migrate data back to unpartitioned tables
--
-- WARNING: If the table swap has already occurred (Post_partitioned renamed to Post),
-- dropping the partitioned tables will DELETE ALL DATA. In this case:
-- 1. First migrate data back to unpartitioned tables
-- 2. Then run this rollback
--
-- This rollback uses "Post_unpartitioned" and "Comment_unpartitioned" as the original
-- table names (matching the forward migration's rename convention).

-- ============================================================================
-- Safety Check: Verify state before proceeding
-- ============================================================================

DO $$
DECLARE
    partitioned_is_primary BOOLEAN := FALSE;
    unpartitioned_exists BOOLEAN := FALSE;
BEGIN
    -- Check if Post_partitioned has been renamed to Post (swap already done)
    SELECT EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = 'Post' 
        AND c.relkind = 'p'  -- 'p' = partitioned table
    ) INTO partitioned_is_primary;

    -- Check if unpartitioned backup tables exist (schema-qualified to avoid false positives)
    SELECT EXISTS(
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = 'Post_unpartitioned'
        AND n.nspname = current_schema()
    ) INTO unpartitioned_exists;

    IF partitioned_is_primary AND NOT unpartitioned_exists THEN
        RAISE EXCEPTION 'UNSAFE ROLLBACK: Post_partitioned is currently the primary table and no backup exists. '
            'Data migration back to unpartitioned table required before rollback. '
            'Create "Post_unpartitioned" and "Comment_unpartitioned" tables and migrate data first.';
    END IF;

    IF partitioned_is_primary THEN
        RAISE NOTICE 'Table swap has occurred. Will restore from *_unpartitioned tables after dropping partitioned tables.';
    ELSE
        RAISE NOTICE 'Table swap has NOT occurred. Safe to drop partitioned staging tables.';
    END IF;
END $$;

-- ============================================================================
-- Step 1: Drop partitioned tables (only if safe)
-- ============================================================================

-- Drop partitioned Comment tables and indexes
DROP TABLE IF EXISTS "Comment_partitioned" CASCADE;

-- Drop partitioned Post tables and indexes  
DROP TABLE IF EXISTS "Post_partitioned" CASCADE;

-- Drop the partition creation function
DROP FUNCTION IF EXISTS create_future_partitions();

-- ============================================================================
-- Step 2: Restore original tables if swap occurred
-- ============================================================================

-- IMPORTANT: If the table swap was completed during forward migration, you need
-- to restore the original unpartitioned tables. This is a MANUAL process:
--
-- PREREQUISITE: The partitioned tables must be dropped FIRST (done in Step 1 above).
-- If "Post" or "Comment" still exist as partitioned tables, RENAME TO will fail.
--
-- BACKUP YOUR DATA before running these commands!
--
-- Manual restoration steps (run in order):
--
-- 1. Verify partitioned tables were dropped:
--    SELECT relname, relkind FROM pg_class WHERE relname IN ('Post', 'Comment');
--    -- Should return empty or show relkind='r' (regular table), NOT 'p' (partitioned)
--
-- 2. If "Post" or "Comment" still exist (as partitioned), drop or rename them:
--    ALTER TABLE "Post" RENAME TO "Post_partitioned_backup";
--    ALTER TABLE "Comment" RENAME TO "Comment_partitioned_backup";
--
-- 3. Restore unpartitioned tables:
--    ALTER TABLE "Post_unpartitioned" RENAME TO "Post";
--    ALTER TABLE "Comment_unpartitioned" RENAME TO "Comment";
--
-- 4. Verify restoration:
--    SELECT COUNT(*) FROM "Post";
--    SELECT COUNT(*) FROM "Comment";

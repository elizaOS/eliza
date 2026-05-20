-- Rollback Migration: Remove targetIds and metadata columns from Message table
-- Use this to undo migration 0030_add_message_target_ids.sql
--
-- Note: PostgreSQL does not support removing values from enums.
-- The 'coordinator' value added to message_type enum cannot be removed.
-- This is safe since unused enum values don't cause issues.

-- ============================================================================
-- Step 1: Drop index
-- ============================================================================

DROP INDEX IF EXISTS "Message_targetIds_idx";

-- ============================================================================
-- Step 2: Drop targetIds column
-- ============================================================================

ALTER TABLE "Message" DROP COLUMN IF EXISTS "targetIds";

-- ============================================================================
-- Step 3: Drop metadata column
-- ============================================================================

ALTER TABLE "Message" DROP COLUMN IF EXISTS "metadata";

-- ============================================================================
-- Step 4: Update any coordinator messages to 'system' type (optional cleanup)
-- ============================================================================

-- Uncomment if you want to reclassify coordinator messages:
-- UPDATE "Message" SET "type" = 'system' WHERE "type" = 'coordinator';

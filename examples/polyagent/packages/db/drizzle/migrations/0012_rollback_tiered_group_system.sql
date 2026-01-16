-- Rollback: Remove Tiered Group System
-- Reverses 0012_add_tiered_group_system.sql
-- 
-- IMPORTANT: This script removes tier data. Run only if you need to fully rollback
-- the tiered group feature. Data in tier columns will be lost.
--
-- Usage: Run manually if rollback is needed. Not auto-executed by Drizzle.

-- Drop indexes first (must exist before dropping columns)
DROP INDEX IF EXISTS "GroupMember_tier_idx";
DROP INDEX IF EXISTS "Group_parentGroupId_idx";
DROP INDEX IF EXISTS "Group_ownerId_tier_idx";
DROP INDEX IF EXISTS "Group_tier_idx";

-- Drop composite indexes from 0013 (if applied)
DROP INDEX IF EXISTS "GroupMember_userId_isActive_tier_idx";
DROP INDEX IF EXISTS "GroupMember_isActive_tier_idx";

-- Remove tier columns from GroupMember table
ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "previousTier";
ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "demotedAt";
ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "promotedAt";
ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "tier";

-- Remove tier columns from Group table
ALTER TABLE "Group" DROP COLUMN IF EXISTS "parentGroupId";
ALTER TABLE "Group" DROP COLUMN IF EXISTS "maxMembers";
ALTER TABLE "Group" DROP COLUMN IF EXISTS "tier";

-- Rollback Migration: Alpha Group Enhancements
-- This reverses all changes from 0023_add_alpha_group_enhancements.sql

-- ============================================================================
-- 1. Drop indexes
-- ============================================================================

DROP INDEX IF EXISTS "GroupInvite_invitedUserId_status_declineCount_idx";
DROP INDEX IF EXISTS "GroupInvite_nextEligibleAt_idx";
DROP INDEX IF EXISTS "GroupMember_isGrandfathered_idx";
DROP INDEX IF EXISTS "AgentTrade_agentUserId_action_executedAt_idx";

-- ============================================================================
-- 2. Remove invite decay columns from GroupInvite
-- ============================================================================

ALTER TABLE "GroupInvite" DROP COLUMN IF EXISTS "declineCount";
ALTER TABLE "GroupInvite" DROP COLUMN IF EXISTS "lastDeclinedAt";
ALTER TABLE "GroupInvite" DROP COLUMN IF EXISTS "nextEligibleAt";

-- ============================================================================
-- 3. Remove grandfathering columns from GroupMember
-- ============================================================================

ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "isGrandfathered";
ALTER TABLE "GroupMember" DROP COLUMN IF EXISTS "grandfatheredAt";


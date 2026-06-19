-- Migration: Alpha Group Enhancements
-- Description: Add invite decay tracking and grandfathering support for alpha group system
-- This migration supports the new alpha group threshold system that:
-- 1. Tracks invite declines with exponential backoff cooldowns
-- 2. Grandfathers existing members when thresholds change
-- 3. Enables per-NPC tier customization

-- ============================================================================
-- 1. Add invite decay columns to GroupInvite
-- ============================================================================

-- Number of times this user has declined invites from this group's NPC
-- Used for exponential backoff: cooldown = baseCooldownHours * 2^(declineCount-1)
ALTER TABLE "GroupInvite" ADD COLUMN IF NOT EXISTS "declineCount" INTEGER NOT NULL DEFAULT 0;

-- When the user last declined an invite (used for decay reset calculation)
-- After 30 days of inactivity, the declineCount resets
ALTER TABLE "GroupInvite" ADD COLUMN IF NOT EXISTS "lastDeclinedAt" TIMESTAMP;

-- When the user becomes eligible for the next invite (computed on decline)
-- If NULL, user is immediately eligible
ALTER TABLE "GroupInvite" ADD COLUMN IF NOT EXISTS "nextEligibleAt" TIMESTAMP;

-- ============================================================================
-- 2. Add grandfathering columns to GroupMember
-- ============================================================================

-- Marks members who joined before a threshold change as grandfathered
-- Grandfathered members retain access even if they don't meet new thresholds
-- However, they cannot be promoted until they meet current requirements
ALTER TABLE "GroupMember" ADD COLUMN IF NOT EXISTS "isGrandfathered" BOOLEAN NOT NULL DEFAULT FALSE;

-- When the member was grandfathered (set during threshold migration)
ALTER TABLE "GroupMember" ADD COLUMN IF NOT EXISTS "grandfatheredAt" TIMESTAMP;

-- ============================================================================
-- 3. Create indexes for efficient querying
-- ============================================================================

-- Index for invite decay queries (filtering by user, status, and decline count)
CREATE INDEX IF NOT EXISTS "GroupInvite_invitedUserId_status_declineCount_idx" 
ON "GroupInvite" ("invitedUserId", "status", "declineCount");

-- Index for next eligible date filtering (finding users eligible for re-invite)
CREATE INDEX IF NOT EXISTS "GroupInvite_nextEligibleAt_idx" 
ON "GroupInvite" ("nextEligibleAt");

-- Index for grandfathering queries
CREATE INDEX IF NOT EXISTS "GroupMember_isGrandfathered_idx" 
ON "GroupMember" ("isGrandfathered");

-- ============================================================================
-- 4. Grandfather all existing active members
-- This ensures existing users aren't kicked when new thresholds are applied
-- Wrapped in DO block to make idempotent - only runs if no grandfathered members exist
-- ============================================================================

DO $$
BEGIN
    -- Only grandfather members if this migration hasn't run before
    -- (i.e., no members are grandfathered yet)
    IF NOT EXISTS (SELECT 1 FROM "GroupMember" WHERE "isGrandfathered" = TRUE LIMIT 1) THEN
        UPDATE "GroupMember" 
        SET "isGrandfathered" = TRUE, "grandfatheredAt" = NOW() 
        WHERE "isActive" = TRUE;
    END IF;
END $$;

-- ============================================================================
-- 5. Add index for efficient trading stats queries (if not exists)
-- This supports the new trading activity in engagement score calculation
-- ============================================================================

CREATE INDEX IF NOT EXISTS "AgentTrade_agentUserId_action_executedAt_idx"
ON "AgentTrade" ("agentUserId", "action", "executedAt");


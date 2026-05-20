-- Migration: Add CHECK constraints for tier column validation
-- Ensures tier values are always in valid range (1, 2, 3) or NULL

-- Add CHECK constraint to Group table
ALTER TABLE "Group" ADD CONSTRAINT "Group_tier_check" CHECK ("tier" IS NULL OR "tier" IN (1, 2, 3));

-- Add CHECK constraint to GroupMember table
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_tier_check" CHECK ("tier" IS NULL OR "tier" IN (1, 2, 3));

-- Add CHECK constraint to GroupMember previousTier column
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_previousTier_check" CHECK ("previousTier" IS NULL OR "previousTier" IN (1, 2, 3));

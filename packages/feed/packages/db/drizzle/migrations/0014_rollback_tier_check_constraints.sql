-- Rollback: Remove CHECK constraints for tier column validation

ALTER TABLE "GroupMember" DROP CONSTRAINT IF EXISTS "GroupMember_previousTier_check";
ALTER TABLE "GroupMember" DROP CONSTRAINT IF EXISTS "GroupMember_tier_check";
ALTER TABLE "Group" DROP CONSTRAINT IF EXISTS "Group_tier_check";

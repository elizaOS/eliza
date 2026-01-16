-- Rollback: Remove GroupMember unique constraint
-- WARNING: This will break ON CONFLICT upsert operations in group member addition flow

ALTER TABLE "GroupMember" 
DROP CONSTRAINT IF EXISTS "GroupMember_groupId_userId_key";


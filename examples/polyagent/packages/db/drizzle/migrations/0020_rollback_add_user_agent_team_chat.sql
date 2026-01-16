-- Rollback: Remove UserAgentTeamChat table

-- Drop foreign key constraints first
ALTER TABLE IF EXISTS "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_userId_fkey";
ALTER TABLE IF EXISTS "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_groupId_fkey";
ALTER TABLE IF EXISTS "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_chatId_fkey";

-- Drop indexes
DROP INDEX IF EXISTS "UserAgentTeamChat_chatId_idx";
DROP INDEX IF EXISTS "UserAgentTeamChat_groupId_idx";

-- Drop table
DROP TABLE IF EXISTS "UserAgentTeamChat";


-- Migration: Simplify Team Chat Schema
-- 1. Add 'team' type to group_type enum
-- 2. Add activeChatId column to Group table
-- 3. Drop UserAgentTeamChat table (functionality moved to Group table)
-- 4. Ensure unique index on team groups (in case 0024 ran before 'team' was added)
--
-- NOTE: Run AFTER 0024_add_team_group_unique_constraint.sql
-- The unique index from 0024 will start enforcing once this migration adds the 'team' type

-- Step 1: Add 'team' to the group_type enum
-- This MUST be run outside a transaction in PostgreSQL
ALTER TYPE "group_type" ADD VALUE IF NOT EXISTS 'team';

-- Step 2: Add activeChatId column to Group table
-- This stores the currently active Chat for team groups (Command Center)
ALTER TABLE "Group" ADD COLUMN IF NOT EXISTS "activeChatId" text;

-- Step 3: Migrate existing UserAgentTeamChat data to Group table
-- Update Group records that are team chats with their activeChatId
UPDATE "Group" g
SET "activeChatId" = uatc."chatId",
    "type" = 'team'
FROM "UserAgentTeamChat" uatc
WHERE g."id" = uatc."groupId";

-- Step 4: Drop foreign key constraints from UserAgentTeamChat
ALTER TABLE "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_userId_fkey";
ALTER TABLE "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_groupId_fkey";
ALTER TABLE "UserAgentTeamChat" DROP CONSTRAINT IF EXISTS "UserAgentTeamChat_chatId_fkey";

-- Step 5: Drop indexes from UserAgentTeamChat
DROP INDEX IF EXISTS "UserAgentTeamChat_groupId_idx";
DROP INDEX IF EXISTS "UserAgentTeamChat_chatId_idx";

-- Step 6: Drop the UserAgentTeamChat table
DROP TABLE IF EXISTS "UserAgentTeamChat";

-- Step 7: Ensure unique index exists (safety - in case 0024 didn't run)
CREATE UNIQUE INDEX IF NOT EXISTS "Group_team_ownerId_unique" 
ON "Group" ("ownerId") 
WHERE type = 'team';


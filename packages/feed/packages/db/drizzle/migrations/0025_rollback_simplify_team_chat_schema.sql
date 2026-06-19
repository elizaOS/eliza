-- Rollback: Simplify Team Chat Schema
-- WARNING: This rollback requires manual data migration if you have team groups!

-- Step 1: Recreate UserAgentTeamChat table
CREATE TABLE IF NOT EXISTS "UserAgentTeamChat" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL UNIQUE,
  "groupId" text NOT NULL UNIQUE,
  "chatId" text NOT NULL UNIQUE,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

-- Step 2: Add indexes
CREATE INDEX IF NOT EXISTS "UserAgentTeamChat_groupId_idx" ON "UserAgentTeamChat" ("groupId");
CREATE INDEX IF NOT EXISTS "UserAgentTeamChat_chatId_idx" ON "UserAgentTeamChat" ("chatId");

-- Step 3: Add foreign key constraints
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_groupId_fkey" 
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE;
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_chatId_fkey" 
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE;

-- Step 4: Migrate data back from Group to UserAgentTeamChat
-- NOTE: This requires generating new IDs for the records
-- Manual intervention may be needed for proper rollback

-- Step 5: Remove activeChatId column from Group
ALTER TABLE "Group" DROP COLUMN IF EXISTS "activeChatId";

-- Note: Cannot remove 'team' from group_type enum in PostgreSQL without recreating the type
-- The 'team' value will remain but won't be used


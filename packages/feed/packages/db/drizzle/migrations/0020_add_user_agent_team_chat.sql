-- Migration: Add UserAgentTeamChat table for Agent Command Center
-- Each user has exactly ONE team chat containing all their agents

CREATE TABLE IF NOT EXISTS "UserAgentTeamChat" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL UNIQUE,
  "groupId" text NOT NULL UNIQUE,
  "chatId" text NOT NULL UNIQUE,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

-- Indexes for efficient lookups (userId already has unique index from UNIQUE constraint)
CREATE INDEX IF NOT EXISTS "UserAgentTeamChat_groupId_idx" ON "UserAgentTeamChat" ("groupId");
CREATE INDEX IF NOT EXISTS "UserAgentTeamChat_chatId_idx" ON "UserAgentTeamChat" ("chatId");

-- Add foreign key constraints for data integrity
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_groupId_fkey" 
  FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE;
ALTER TABLE "UserAgentTeamChat" ADD CONSTRAINT "UserAgentTeamChat_chatId_fkey" 
  FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE;


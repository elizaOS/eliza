-- Migration: Add unique constraint for team groups (Command Center)
-- Ensures only ONE team group (Command Center) per owner to prevent race condition duplicates

-- Add partial unique index on ownerId for team type groups only
-- This prevents duplicate Command Centers for the same user
CREATE UNIQUE INDEX IF NOT EXISTS "Group_team_ownerId_unique" 
ON "Group" ("ownerId") 
WHERE type = 'team';


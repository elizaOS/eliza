-- Migration: Add Tiered Group System
-- Adds tier support to Group and GroupMember tables for NPC groups

-- Add tier columns to Group table
ALTER TABLE "Group" ADD COLUMN "tier" integer;
ALTER TABLE "Group" ADD COLUMN "maxMembers" integer;
ALTER TABLE "Group" ADD COLUMN "parentGroupId" text;

-- Add tier columns to GroupMember table
ALTER TABLE "GroupMember" ADD COLUMN "tier" integer;
ALTER TABLE "GroupMember" ADD COLUMN "promotedAt" timestamp;
ALTER TABLE "GroupMember" ADD COLUMN "demotedAt" timestamp;
ALTER TABLE "GroupMember" ADD COLUMN "previousTier" integer;

-- Add indexes for efficient tier queries
CREATE INDEX "Group_tier_idx" ON "Group" ("tier");
CREATE INDEX "Group_ownerId_tier_idx" ON "Group" ("ownerId", "tier");
CREATE INDEX "Group_parentGroupId_idx" ON "Group" ("parentGroupId");
CREATE INDEX "GroupMember_tier_idx" ON "GroupMember" ("tier");

-- Migrate existing NPC groups to Tier 1 (Inner Circle)
UPDATE "Group"
SET 
  "tier" = 1,
  "maxMembers" = 12
WHERE "type" = 'npc'
  AND "tier" IS NULL;

-- Update existing memberships to Tier 1
UPDATE "GroupMember" gm
SET "tier" = 1
FROM "Group" g
WHERE gm."groupId" = g.id
  AND g."type" = 'npc'
  AND gm."tier" IS NULL;

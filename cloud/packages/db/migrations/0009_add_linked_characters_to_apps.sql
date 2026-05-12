-- Add linked_character_ids column to apps table
-- This allows apps to have up to 4 linked AI characters/agents
-- that can be used for chat within the app

ALTER TABLE "apps" ADD COLUMN "linked_character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Add an index for efficient lookup of apps by character
CREATE INDEX "apps_linked_characters_gin_idx" ON "apps" USING gin ("linked_character_ids");

-- Comment for documentation
COMMENT ON COLUMN "apps"."linked_character_ids" IS 'Array of character UUIDs (max 4) that can be used for chat within this app';

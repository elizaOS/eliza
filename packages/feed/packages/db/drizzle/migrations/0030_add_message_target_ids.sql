-- Migration: Add targetIds and metadata columns, and coordinator message type
-- Purpose: Enable message routing in team chat and action tag display
--
-- This allows:
-- - User messages without @mentions to target 'coordinator'
-- - User messages with @mentions to target specific agent IDs
-- - Proper filtering in recentMessages providers for scoped context
-- - Coordinator messages to be identified by their type in addition to senderId
-- - Action tags (perps, predictions, pnl, etc.) to be displayed on messages

-- ============================================================================
-- Step 1: Add 'coordinator' to message_type enum
-- ============================================================================

-- NOTE: ALTER TYPE ADD VALUE cannot run inside a transaction in PostgreSQL.
-- If your migration runner wraps this in a transaction and it fails, run manually:
--   psql $DATABASE_URL -c "ALTER TYPE \"message_type\" ADD VALUE IF NOT EXISTS 'coordinator';"
-- The IF NOT EXISTS clause makes this idempotent and safe to retry.
ALTER TYPE "message_type" ADD VALUE IF NOT EXISTS 'coordinator';

-- ============================================================================
-- Step 2: Add targetIds column
-- ============================================================================

-- Add nullable text array column for target IDs
-- NULL for non-team-chat messages and agent/coordinator responses
-- Contains ['coordinator'] for messages without @mentions
-- Contains agent IDs for messages with @mentions
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "targetIds" TEXT[];

-- ============================================================================
-- Step 3: Add metadata column for action tags
-- ============================================================================

-- Add nullable JSONB column for message metadata (action tags, etc.)
-- Contains tags from actions like CHECK_PERPS, CHECK_PREDICTIONS, etc.
-- Tags are displayed as clickable buttons on messages that open sidebar panels
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- ============================================================================
-- Step 4: Create index for efficient array lookups
-- ============================================================================

-- GIN index for array containment queries
-- NOTE: This index is optimized for containment operators (@>, <@, &&)
-- Queries should use: "targetIds" @> ARRAY['value'] (array contains value)
-- NOT: 'value' = ANY("targetIds") (ANY() doesn't use GIN efficiently)
CREATE INDEX IF NOT EXISTS "Message_targetIds_idx" ON "Message" USING GIN ("targetIds");

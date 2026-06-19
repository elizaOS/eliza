-- Migration: Add case-insensitive index on username for better performance
-- Issue: BAB-100 - Agent profile loading with usernames containing spaces/mixed case

-- Create index on lower(username) for case-insensitive lookups
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_username_lower" ON "User" (lower("username"));

-- Add comment for documentation
COMMENT ON INDEX "idx_users_username_lower" IS 'Case-insensitive username lookup index for agent/user profile loading';

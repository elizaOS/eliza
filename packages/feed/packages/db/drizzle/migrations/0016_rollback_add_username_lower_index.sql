-- Rollback Migration: Remove case-insensitive username index
-- Issue: BAB-100 - Agent profile loading with usernames containing spaces/mixed case

-- Drop the index
DROP INDEX CONCURRENTLY IF EXISTS "idx_users_username_lower";

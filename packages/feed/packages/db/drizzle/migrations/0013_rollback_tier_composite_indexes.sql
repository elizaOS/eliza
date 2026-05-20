-- Rollback: Remove Tier Composite Indexes
-- Reverses 0013_add_tier_composite_indexes.sql
--
-- Usage: Run manually if rollback is needed. Not auto-executed by Drizzle.

DROP INDEX IF EXISTS "GroupMember_userId_isActive_tier_idx";
DROP INDEX IF EXISTS "GroupMember_isActive_tier_idx";

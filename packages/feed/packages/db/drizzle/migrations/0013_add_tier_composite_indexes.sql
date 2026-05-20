-- Migration: Add Composite Indexes for Tier Queries
-- Improves performance for tiered group system queries (PR #670 fixes)

-- Composite index for getUserTierStatus query
-- Filters: userId, isActive, tier
CREATE INDEX CONCURRENTLY IF NOT EXISTS "GroupMember_userId_isActive_tier_idx" 
  ON "GroupMember"("userId", "isActive", "tier");

-- Composite index for processAllPromotions/Demotions queries  
-- Filters: isActive, tier
CREATE INDEX CONCURRENTLY IF NOT EXISTS "GroupMember_isActive_tier_idx"
  ON "GroupMember"("isActive", "tier");

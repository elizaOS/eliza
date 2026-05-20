-- Add composite indexes for optimized sub-market queries
-- These partial indexes are smaller and faster for the specific query patterns

-- Composite index for sub-market count queries
-- Query: SELECT count(*) FROM TimeframedMarket WHERE isActive = true AND parentMarketId IS NOT NULL
-- The partial index only includes rows where parentMarketId IS NOT NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TimeframedMarket_isActive_parentMarketId_idx" 
  ON "TimeframedMarket" ("isActive", "parentMarketId") 
  WHERE "parentMarketId" IS NOT NULL;

-- Partial index for main market queries (parentMarketId IS NULL)
-- Query: SELECT * FROM TimeframedMarket WHERE isActive = true AND parentMarketId IS NULL
-- The partial index only includes rows where parentMarketId IS NULL
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TimeframedMarket_isActive_mainMarket_idx" 
  ON "TimeframedMarket" ("isActive") 
  WHERE "parentMarketId" IS NULL;

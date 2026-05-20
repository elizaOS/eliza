-- Migration: Add indexes for admin stats queries performance
-- These indexes improve query performance for admin dashboard statistics
-- Using CONCURRENTLY to avoid locking tables during index creation

-- Trading stats: BalanceTransaction queries filter by type + createdAt
-- Existing: BalanceTransaction_type_idx, BalanceTransaction_userId_createdAt_idx
-- Adding composite index for type + createdAt to optimize date-range queries by type
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BalanceTransaction_type_createdAt_idx" 
  ON "BalanceTransaction"("type", "createdAt");

-- Trading stats: Top traders query filters by userId + type
CREATE INDEX CONCURRENTLY IF NOT EXISTS "BalanceTransaction_userId_type_idx" 
  ON "BalanceTransaction"("userId", "type");

-- User stats: Filter by isActor + createdAt for daily signups
-- Existing: User_isActor_idx (single column)
-- Adding composite index for isActor + createdAt
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_isActor_createdAt_idx" 
  ON "User"("isActor", "createdAt");

-- User stats: Filter by isAgent + createdAt for agent signups
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_isAgent_createdAt_idx" 
  ON "User"("isAgent", "createdAt");

-- LLM monitoring: Time-series queries on LlmCallLog (uses snake_case table name)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "llm_call_logs_createdAt_idx" 
  ON "llm_call_logs"("createdAt");

-- NOTE: The following indexes already exist in the schema:
-- - TradingFee_createdAt_idx (trading.ts)
-- - NPCTrade_executedAt_idx (actors.ts)
-- - llm_call_logs_timestamp_idx (training.ts)

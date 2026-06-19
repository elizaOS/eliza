-- Add index for efficient shouldUpdateWorldFacts() lookup
-- This query runs every game tick to check when world facts were last generated
-- Using CONCURRENTLY to avoid blocking writes during index creation
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WorldFact_source_createdAt_idx" ON "WorldFact" ("source", "createdAt" DESC);

-- Create SystemMetricsSnapshot table for hourly platform metrics
-- Stores aggregated metrics for efficient time-series queries
--
-- This table complements AnalyticsDailySnapshot (daily granularity) with:
-- - Hourly granularity for recent trend analysis
-- - System health metrics (uptime, response time, error rate)
-- - Environment-specific snapshots (production/staging/development)
--
-- Used by:
-- - GET /api/admin/stats/timeseries - Returns historical metrics
-- - POST /api/cron/metrics-snapshot - Creates hourly snapshots (Vercel Cron)

CREATE TABLE IF NOT EXISTS "SystemMetricsSnapshot" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "timestamp" TIMESTAMP NOT NULL,
  "environment" TEXT NOT NULL,
  
  -- User metrics
  "totalUsers" INTEGER NOT NULL,
  "activeUsers" INTEGER NOT NULL,
  "newSignups" INTEGER NOT NULL,
  
  -- Trading metrics (prediction markets)
  "tradingVolume" DECIMAL(18, 2) NOT NULL,
  "activeMarkets" INTEGER NOT NULL,
  "openPositions" INTEGER NOT NULL,
  
  -- Trading metrics (perpetuals)
  "perpVolume" DECIMAL(18, 2) NOT NULL DEFAULT '0',
  "activePerpPositions" INTEGER NOT NULL DEFAULT 0,
  
  -- Social metrics
  "postsCreated" INTEGER NOT NULL DEFAULT 0,
  "commentsCreated" INTEGER NOT NULL DEFAULT 0,
  "reactionsCreated" INTEGER NOT NULL DEFAULT 0,
  
  -- Financial metrics
  "totalVirtualBalance" DECIMAL(20, 2) NOT NULL,
  "feesCollectedHourly" DECIMAL(18, 2) NOT NULL,
  
  -- System health metrics
  "apiUptime" DOUBLE PRECISION NOT NULL,
  "avgResponseTime" DOUBLE PRECISION NOT NULL,
  "errorRate" DOUBLE PRECISION NOT NULL,
  
  -- Cron job health
  "cronJobsHealthy" INTEGER NOT NULL DEFAULT 0,
  "cronJobsUnhealthy" INTEGER NOT NULL DEFAULT 0,
  
  -- Extended metrics (JSON for flexibility)
  "extendedMetrics" JSON,
  
  -- Metadata
  "snapshotDurationMs" INTEGER NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for efficient queries
-- Time range queries for single environment (most common query pattern)
CREATE INDEX IF NOT EXISTS "SystemMetricsSnapshot_environment_timestamp_idx" 
  ON "SystemMetricsSnapshot" ("environment", "timestamp");

-- Cleanup/retention queries
CREATE INDEX IF NOT EXISTS "SystemMetricsSnapshot_createdAt_idx" 
  ON "SystemMetricsSnapshot" ("createdAt");

-- Unique constraint to prevent duplicate snapshots for same hour/environment
-- This allows the cron job to safely use onConflictDoNothing for atomic upserts
-- Also serves as the primary lookup index (timestamp + environment)
CREATE UNIQUE INDEX IF NOT EXISTS "SystemMetricsSnapshot_timestamp_environment_unique_idx"
  ON "SystemMetricsSnapshot" ("timestamp", "environment");


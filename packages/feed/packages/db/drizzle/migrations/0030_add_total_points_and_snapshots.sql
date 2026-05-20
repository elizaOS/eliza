-- Migration: Add totalPoints column to User table and UserPointsSnapshot table
-- Purpose: Unified points system (BAB-173) - totalPoints = wallet + positions (excludes agents)

-- Add totalPoints column to User table
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalPoints" DECIMAL(18, 2) NOT NULL DEFAULT '0';

-- Index for fast leaderboard sorting by totalPoints
CREATE INDEX IF NOT EXISTS "User_totalPoints_idx" ON "User" ("totalPoints");

-- Create UserPointsSnapshot table for daily/weekly gain tracking
CREATE TABLE IF NOT EXISTS "UserPointsSnapshot" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "totalPoints" DECIMAL(18, 2) NOT NULL DEFAULT '0',
  "snapshotDate" TIMESTAMP NOT NULL,
  "period" TEXT NOT NULL DEFAULT 'daily',
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for snapshot queries
CREATE INDEX IF NOT EXISTS "UserPointsSnapshot_userId_idx"
  ON "UserPointsSnapshot" ("userId");
CREATE INDEX IF NOT EXISTS "UserPointsSnapshot_userId_period_snapshotDate_idx"
  ON "UserPointsSnapshot" ("userId", "period", "snapshotDate");
CREATE INDEX IF NOT EXISTS "UserPointsSnapshot_snapshotDate_idx"
  ON "UserPointsSnapshot" ("snapshotDate");

-- Backfill: Set totalPoints = virtualBalance for all existing users
-- This is a safe initial value; the cron job will recompute with position values
UPDATE "User" SET "totalPoints" = COALESCE(CAST("virtualBalance" AS DECIMAL(18,2)), 0)
WHERE "totalPoints" = 0;

-- Add dirty flag for incremental totalPoints recompute
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalPointsDirtyAt" TIMESTAMP;

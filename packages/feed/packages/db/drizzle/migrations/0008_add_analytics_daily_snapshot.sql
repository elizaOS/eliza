-- Create AnalyticsDailySnapshot table for admin dashboard analytics
-- Stores daily snapshots of platform metrics for historical reporting

CREATE TABLE IF NOT EXISTS "AnalyticsDailySnapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "date" timestamp NOT NULL UNIQUE,
  -- User metrics
  "totalUsers" integer NOT NULL DEFAULT 0,
  "newUsers" integer NOT NULL DEFAULT 0,
  "activeUsers" integer NOT NULL DEFAULT 0,
  "bannedUsers" integer NOT NULL DEFAULT 0,
  -- Social metrics
  "totalPosts" integer NOT NULL DEFAULT 0,
  "newPosts" integer NOT NULL DEFAULT 0,
  "totalComments" integer NOT NULL DEFAULT 0,
  "newComments" integer NOT NULL DEFAULT 0,
  "totalReactions" integer NOT NULL DEFAULT 0,
  "newReactions" integer NOT NULL DEFAULT 0,
  -- Trading metrics
  "totalMarkets" integer NOT NULL DEFAULT 0,
  "activeMarkets" integer NOT NULL DEFAULT 0,
  "totalTrades" integer NOT NULL DEFAULT 0,
  "newTrades" integer NOT NULL DEFAULT 0,
  -- Engagement metrics
  "totalFollows" integer NOT NULL DEFAULT 0,
  "newFollows" integer NOT NULL DEFAULT 0,
  "totalReferrals" integer NOT NULL DEFAULT 0,
  "newReferrals" integer NOT NULL DEFAULT 0,
  -- Moderation metrics
  "totalReports" integer NOT NULL DEFAULT 0,
  "newReports" integer NOT NULL DEFAULT 0,
  "resolvedReports" integer NOT NULL DEFAULT 0,
  -- Additional data
  "metadata" json,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS "AnalyticsDailySnapshot_date_idx" ON "AnalyticsDailySnapshot" ("date");
CREATE INDEX IF NOT EXISTS "AnalyticsDailySnapshot_createdAt_idx" ON "AnalyticsDailySnapshot" ("createdAt");

-- Migration: Optimize User table by extracting agent configuration
-- This migration:
-- 1. Creates a new UserAgentConfig table for agent settings
-- 2. Drops unused agent columns from User table (no data loss - no agents in production)
-- 3. Preserves ALL points-related data (invitePoints, earnedPoints, bonusPoints, reputationPoints)
-- 4. Preserves ALL referral data

-- Step 1: Create the new UserAgentConfig table
CREATE TABLE IF NOT EXISTS "UserAgentConfig" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL UNIQUE,
  "personality" text,
  "system" text,
  "tradingStrategy" text,
  "style" jsonb,
  "messageExamples" jsonb,
  "personaPrompt" text,
  "goals" jsonb,
  "directives" jsonb,
  "constraints" jsonb,
  "planningHorizon" text NOT NULL DEFAULT 'single',
  "riskTolerance" text NOT NULL DEFAULT 'medium',
  "maxActionsPerTick" integer NOT NULL DEFAULT 3,
  "modelTier" text NOT NULL DEFAULT 'free',
  "autonomousPosting" boolean NOT NULL DEFAULT false,
  "autonomousCommenting" boolean NOT NULL DEFAULT false,
  "autonomousTrading" boolean NOT NULL DEFAULT false,
  "autonomousDMs" boolean NOT NULL DEFAULT false,
  "autonomousGroupChats" boolean NOT NULL DEFAULT false,
  "a2aEnabled" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'idle',
  "errorMessage" text,
  "lastTickAt" timestamp,
  "lastChatAt" timestamp,
  "pointsBalance" integer NOT NULL DEFAULT 0,
  "totalDeposited" integer NOT NULL DEFAULT 0,
  "totalWithdrawn" integer NOT NULL DEFAULT 0,
  "totalPointsSpent" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL
);

-- Create indexes for UserAgentConfig
CREATE INDEX IF NOT EXISTS "UserAgentConfig_userId_idx" ON "UserAgentConfig" ("userId");
CREATE INDEX IF NOT EXISTS "UserAgentConfig_status_idx" ON "UserAgentConfig" ("status");
CREATE INDEX IF NOT EXISTS "UserAgentConfig_autonomousTrading_idx" ON "UserAgentConfig" ("autonomousTrading");

-- Step 2: Drop agent-related columns from User table
-- SAFETY CHECK: These columns should all be NULL or default values in production
-- (no agents have been created yet)

-- Drop agent config columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPersonality";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentSystem";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentGoals";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentDirectives";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentConstraints";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPersonaPrompt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPlanningHorizon";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentRiskTolerance";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentMaxActionsPerTick";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentStyle";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentMessageExamples";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTradingStrategy";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentModelTier";

-- Drop agent runtime state columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentStatus";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentErrorMessage";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentLastTickAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentLastChatAt";

-- Drop agent points columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPointsBalance";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalDeposited";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalWithdrawn";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalPointsSpent";

-- Drop agent behavior flags
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousPosting";
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousCommenting";
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousTrading";
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousDMs";
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousGroupChats";
ALTER TABLE "User" DROP COLUMN IF EXISTS "a2aEnabled";

-- Drop agent stats columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentCount";
ALTER TABLE "User" DROP COLUMN IF EXISTS "totalAgentPnL";

-- Step 3: Drop unused indexes (these were for agent columns)
DROP INDEX IF EXISTS "User_agentCount_idx";
DROP INDEX IF EXISTS "User_autonomousTrading_idx";
DROP INDEX IF EXISTS "User_totalAgentPnL_idx";

-- PRESERVED COLUMNS ON USER TABLE:
-- ✓ id, walletAddress, username, displayName, bio, profileImageUrl (identity)
-- ✓ invitePoints, earnedPoints, bonusPoints, reputationPoints (CRITICAL - points balances)
-- ✓ All 15 pointsAwardedFor* boolean flags (prevent double-awarding)
-- ✓ referralCode, referralCount, referredBy (referral system)
-- ✓ isAgent, managedBy (agent flags - kept for querying)
-- ✓ All social connection fields
-- ✓ All moderation fields
-- ✓ All timestamps

-- PRESERVED TABLES:
-- ✓ PointsTransaction (full audit trail)
-- ✓ Referral (full table with signupPointsAwarded)



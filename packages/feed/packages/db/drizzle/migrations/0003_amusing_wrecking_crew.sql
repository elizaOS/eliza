-- Migration made idempotent to handle partial application states
-- All CREATE TABLE, CREATE INDEX, DROP INDEX, and ALTER TABLE statements
-- now use IF EXISTS/IF NOT EXISTS to be safe across environments

CREATE TABLE IF NOT EXISTS "ActorState" (
	"id" text PRIMARY KEY NOT NULL,
	"tradingBalance" numeric(18, 2) DEFAULT '10000' NOT NULL,
	"reputationPoints" integer DEFAULT 10000 NOT NULL,
	"hasPool" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "OrganizationState" (
	"id" text PRIMARY KEY NOT NULL,
	"currentPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "TickTokenStats" (
	"id" text PRIMARY KEY NOT NULL,
	"tickId" text NOT NULL,
	"tickStartedAt" timestamp NOT NULL,
	"tickCompletedAt" timestamp NOT NULL,
	"tickDurationMs" integer NOT NULL,
	"totalCalls" integer NOT NULL,
	"totalInputTokens" integer NOT NULL,
	"totalOutputTokens" integer NOT NULL,
	"totalTokens" integer NOT NULL,
	"byPromptType" json NOT NULL,
	"byModel" json NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "UserAgentConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"personality" text,
	"system" text,
	"tradingStrategy" text,
	"style" json,
	"messageExamples" json,
	"personaPrompt" text,
	"goals" json,
	"directives" json,
	"constraints" json,
	"planningHorizon" text DEFAULT 'single' NOT NULL,
	"riskTolerance" text DEFAULT 'medium' NOT NULL,
	"maxActionsPerTick" integer DEFAULT 3 NOT NULL,
	"modelTier" text DEFAULT 'free' NOT NULL,
	"autonomousPosting" boolean DEFAULT false NOT NULL,
	"autonomousCommenting" boolean DEFAULT false NOT NULL,
	"autonomousTrading" boolean DEFAULT false NOT NULL,
	"autonomousDMs" boolean DEFAULT false NOT NULL,
	"autonomousGroupChats" boolean DEFAULT false NOT NULL,
	"a2aEnabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"errorMessage" text,
	"lastTickAt" timestamp,
	"lastChatAt" timestamp,
	"pointsBalance" integer DEFAULT 0 NOT NULL,
	"totalDeposited" integer DEFAULT 0 NOT NULL,
	"totalWithdrawn" integer DEFAULT 0 NOT NULL,
	"totalPointsSpent" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "UserAgentConfig_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
DROP INDEX IF EXISTS "User_agentCount_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "User_autonomousTrading_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "User_totalAgentPnL_idx";--> statement-breakpoint
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "chatId" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ActorState_hasPool_idx" ON "ActorState" USING btree ("hasPool");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ActorState_reputationPoints_idx" ON "ActorState" USING btree ("reputationPoints");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "OrganizationState_currentPrice_idx" ON "OrganizationState" USING btree ("currentPrice");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TickTokenStats_tickStartedAt_idx" ON "TickTokenStats" USING btree ("tickStartedAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TickTokenStats_tickId_idx" ON "TickTokenStats" USING btree ("tickId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TickTokenStats_createdAt_idx" ON "TickTokenStats" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserAgentConfig_userId_idx" ON "UserAgentConfig" USING btree ("userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserAgentConfig_status_idx" ON "UserAgentConfig" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserAgentConfig_autonomousTrading_idx" ON "UserAgentConfig" USING btree ("autonomousTrading");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Notification_chatId_idx" ON "Notification" USING btree ("chatId");--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentCount";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "totalAgentPnL";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentErrorMessage";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentLastChatAt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentLastTickAt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentMessageExamples";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentModelTier";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPersonality";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPointsBalance";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentStatus";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentStyle";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentSystem";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalDeposited";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalPointsSpent";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTotalWithdrawn";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentTradingStrategy";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousCommenting";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousDMs";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousGroupChats";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousPosting";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "autonomousTrading";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "a2aEnabled";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentGoals";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentDirectives";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentConstraints";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPersonaPrompt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentPlanningHorizon";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentRiskTolerance";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN IF EXISTS "agentMaxActionsPerTick";

CREATE TABLE "ActorState" (
	"id" text PRIMARY KEY NOT NULL,
	"tradingBalance" numeric(18, 2) DEFAULT '10000' NOT NULL,
	"reputationPoints" integer DEFAULT 10000 NOT NULL,
	"hasPool" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OrganizationState" (
	"id" text PRIMARY KEY NOT NULL,
	"currentPrice" double precision,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TickTokenStats" (
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
CREATE TABLE "UserAgentConfig" (
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
DROP INDEX "User_agentCount_idx";--> statement-breakpoint
DROP INDEX "User_autonomousTrading_idx";--> statement-breakpoint
DROP INDEX "User_totalAgentPnL_idx";--> statement-breakpoint
ALTER TABLE "Notification" ADD COLUMN "chatId" text;--> statement-breakpoint
CREATE INDEX "ActorState_hasPool_idx" ON "ActorState" USING btree ("hasPool");--> statement-breakpoint
CREATE INDEX "ActorState_reputationPoints_idx" ON "ActorState" USING btree ("reputationPoints");--> statement-breakpoint
CREATE INDEX "OrganizationState_currentPrice_idx" ON "OrganizationState" USING btree ("currentPrice");--> statement-breakpoint
CREATE INDEX "TickTokenStats_tickStartedAt_idx" ON "TickTokenStats" USING btree ("tickStartedAt");--> statement-breakpoint
CREATE INDEX "TickTokenStats_tickId_idx" ON "TickTokenStats" USING btree ("tickId");--> statement-breakpoint
CREATE INDEX "TickTokenStats_createdAt_idx" ON "TickTokenStats" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_userId_idx" ON "UserAgentConfig" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_status_idx" ON "UserAgentConfig" USING btree ("status");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_autonomousTrading_idx" ON "UserAgentConfig" USING btree ("autonomousTrading");--> statement-breakpoint
CREATE INDEX "Notification_chatId_idx" ON "Notification" USING btree ("chatId");--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentCount";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "totalAgentPnL";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentErrorMessage";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentLastChatAt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentLastTickAt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentMessageExamples";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentModelTier";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentPersonality";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentPointsBalance";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentStatus";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentStyle";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentSystem";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentTotalDeposited";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentTotalPointsSpent";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentTotalWithdrawn";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentTradingStrategy";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "autonomousCommenting";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "autonomousDMs";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "autonomousGroupChats";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "autonomousPosting";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "autonomousTrading";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "a2aEnabled";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentGoals";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentDirectives";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentConstraints";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentPersonaPrompt";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentPlanningHorizon";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentRiskTolerance";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "agentMaxActionsPerTick";
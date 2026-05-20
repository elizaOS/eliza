CREATE TABLE IF NOT EXISTS "AchievementDefinition" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"tier" text NOT NULL,
	"iconKey" text NOT NULL,
	"pointsReward" integer NOT NULL,
	"threshold" integer NOT NULL,
	"trackingType" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ChallengeDefinition" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"pool" text NOT NULL,
	"category" text NOT NULL,
	"iconKey" text NOT NULL,
	"pointsReward" integer NOT NULL,
	"threshold" integer NOT NULL,
	"trackingType" text NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "UserAchievement" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"achievementId" text NOT NULL,
	"unlockedAt" timestamp DEFAULT now() NOT NULL,
	"pointsAwarded" integer NOT NULL,
	CONSTRAINT "UserAchievement_userId_achievementId_idx" UNIQUE("userId","achievementId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "UserChallengeProgress" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"challengeId" text NOT NULL,
	"periodKey" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"completedAt" timestamp,
	"pointsAwarded" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "UserChallengeProgress_userId_challengeId_periodKey_idx" UNIQUE("userId","challengeId","periodKey")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserAchievement_userId_idx" ON "UserAchievement" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserAchievement_unlockedAt_idx" ON "UserAchievement" USING btree ("unlockedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "UserChallengeProgress_userId_periodKey_idx" ON "UserChallengeProgress" USING btree ("userId","periodKey");

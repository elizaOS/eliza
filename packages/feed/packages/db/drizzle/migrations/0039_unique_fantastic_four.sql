-- Migration: Add Whitelist and WhitelistConfig tables
-- Purpose: Whitelisting system for game access gating bypass
--
-- Three whitelist sources:
-- 1. snapshot_first_100: End-of-year top-100 user snapshot
-- 2. admin_manual: Ad-hoc admin whitelisting
-- 3. leaderboard: Leaderboard rank-based whitelisting

CREATE TABLE IF NOT EXISTS "Whitelist" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"grantedBy" text,
	"grantedAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp,
	CONSTRAINT "Whitelist_userId_unique" UNIQUE("userId")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "WhitelistConfig" (
	"id" text PRIMARY KEY NOT NULL,
	"leaderboardRankThreshold" integer,
	"leaderboardCategory" text DEFAULT 'all' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
ALTER TABLE "Whitelist" ADD CONSTRAINT "Whitelist_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "Whitelist" ADD CONSTRAINT "Whitelist_grantedBy_User_id_fk" FOREIGN KEY ("grantedBy") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "WhitelistConfig" ADD CONSTRAINT "WhitelistConfig_updatedBy_User_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Whitelist_userId_idx" ON "Whitelist" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Whitelist_source_idx" ON "Whitelist" USING btree ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Whitelist_revokedAt_idx" ON "Whitelist" USING btree ("revokedAt");

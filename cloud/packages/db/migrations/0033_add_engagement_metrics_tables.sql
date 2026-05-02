-- Custom SQL migration file, put your code below! --
-- Pre-computed engagement metrics tables for V1 user engagement KPIs.

CREATE TABLE IF NOT EXISTS "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"date" timestamp NOT NULL,
	"platform" text,
	"dau" integer NOT NULL DEFAULT 0,
	"new_signups" integer NOT NULL DEFAULT 0,
	"total_messages" integer NOT NULL DEFAULT 0,
	"messages_per_user" numeric(10, 2) DEFAULT '0',
	"created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_date_platform_idx"
	ON "daily_metrics" ("date", "platform");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_metrics_date_idx"
	ON "daily_metrics" ("date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"cohort_date" timestamp NOT NULL,
	"platform" text,
	"cohort_size" integer NOT NULL,
	"d1_retained" integer,
	"d7_retained" integer,
	"d30_retained" integer,
	"updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "retention_cohorts_cohort_platform_idx"
	ON "retention_cohorts" ("cohort_date", "platform");

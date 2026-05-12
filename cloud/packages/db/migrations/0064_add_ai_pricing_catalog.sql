CREATE TABLE IF NOT EXISTS "ai_pricing_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"product_family" text NOT NULL,
	"charge_type" text NOT NULL,
	"unit" text NOT NULL,
	"unit_price" numeric(20, 10) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"dimension_key" text DEFAULT '*' NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text NOT NULL,
	"source_url" text NOT NULL,
	"source_hash" text,
	"fetched_at" timestamp,
	"stale_after" timestamp,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_until" timestamp,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_override" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_pricing_refresh_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"source_url" text,
	"fetched_entries" integer DEFAULT 0 NOT NULL,
	"upserted_entries" integer DEFAULT 0 NOT NULL,
	"deactivated_entries" integer DEFAULT 0 NOT NULL,
	"error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_pricing_entries_lookup_idx" ON "ai_pricing_entries" USING btree ("billing_source","provider","model","product_family","charge_type","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_pricing_entries_dimension_idx" ON "ai_pricing_entries" USING btree ("dimension_key","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_pricing_entries_freshness_idx" ON "ai_pricing_entries" USING btree ("source_kind","fetched_at","stale_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_pricing_refresh_runs_source_status_idx" ON "ai_pricing_refresh_runs" USING btree ("source","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_pricing_refresh_runs_started_idx" ON "ai_pricing_refresh_runs" USING btree ("started_at");
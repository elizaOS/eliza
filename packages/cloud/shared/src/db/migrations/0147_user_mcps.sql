-- User-created MCP registry: the `user_mcps` table (creatable/monetizable MCP
-- servers) plus the `mcp_usage` tracking table and their two enums. The schema
-- (src/db/schemas/user-mcps.ts) shipped without a generated migration, so
-- POST /api/v1/mcps 500'd at runtime (relation does not exist). Authored by
-- hand to match the schema; additive + idempotent so it is safe to apply.
DO $$ BEGIN
	CREATE TYPE "public"."mcp_pricing_type" AS ENUM('free', 'credits', 'x402');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "public"."mcp_status" AS ENUM('draft', 'pending_review', 'live', 'suspended', 'deprecated');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_mcps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"endpoint_type" text DEFAULT 'container' NOT NULL,
	"container_id" uuid,
	"external_endpoint" text,
	"endpoint_path" text DEFAULT '/mcp',
	"transport_type" text DEFAULT 'streamable-http' NOT NULL,
	"mcp_version" text DEFAULT '2025-06-18',
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text DEFAULT 'utilities' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" text DEFAULT 'puzzle',
	"color" text DEFAULT '#6366F1',
	"pricing_type" "mcp_pricing_type" DEFAULT 'credits' NOT NULL,
	"credits_per_request" numeric(10, 4) DEFAULT '1.0000',
	"x402_price_usd" numeric(10, 6) DEFAULT '0.000100',
	"x402_enabled" boolean DEFAULT false NOT NULL,
	"creator_share_percentage" numeric(5, 2) DEFAULT '80.00' NOT NULL,
	"platform_share_percentage" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_credits_earned" numeric(12, 4) DEFAULT '0.0000',
	"total_x402_earned_usd" numeric(12, 6) DEFAULT '0.000000',
	"unique_users" integer DEFAULT 0 NOT NULL,
	"status" "mcp_status" DEFAULT 'draft' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"verified_by" uuid,
	"documentation_url" text,
	"source_code_url" text,
	"support_email" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"erc8004_registered" boolean DEFAULT false NOT NULL,
	"erc8004_network" text,
	"erc8004_agent_id" integer,
	"erc8004_agent_uri" text,
	"erc8004_tx_hash" text,
	"erc8004_registered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"published_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"tool_name" text NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"credits_charged" numeric(10, 4) DEFAULT '0.0000',
	"x402_amount_usd" numeric(10, 6) DEFAULT '0.000000',
	"payment_type" text DEFAULT 'credits' NOT NULL,
	"creator_earnings" numeric(10, 4) DEFAULT '0.0000',
	"platform_earnings" numeric(10, 4) DEFAULT '0.0000',
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_container_id_containers_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."containers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_mcps" ADD CONSTRAINT "user_mcps_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_mcp_id_user_mcps_id_fk" FOREIGN KEY ("mcp_id") REFERENCES "public"."user_mcps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_mcps_slug_org_idx" ON "user_mcps" USING btree ("slug","organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_organization_idx" ON "user_mcps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_created_by_idx" ON "user_mcps" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_container_idx" ON "user_mcps" USING btree ("container_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_category_idx" ON "user_mcps" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_status_idx" ON "user_mcps" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_is_public_idx" ON "user_mcps" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_created_at_idx" ON "user_mcps" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_mcps_erc8004_registered_idx" ON "user_mcps" USING btree ("erc8004_registered");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_usage_mcp_id_idx" ON "mcp_usage" USING btree ("mcp_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_usage_organization_idx" ON "mcp_usage" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_usage_user_idx" ON "mcp_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_usage_created_at_idx" ON "mcp_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_usage_mcp_org_idx" ON "mcp_usage" USING btree ("mcp_id","organization_id");

-- Targeted migration: affiliate_codes, user_affiliates, agent_server_wallets only.
-- Replaces full-schema omnibus; signup code index is in 0035. Uses IF NOT EXISTS / idempotent FKs.

CREATE TABLE IF NOT EXISTS "affiliate_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"parent_referral_id" uuid,
	"markup_percent" numeric(6, 2) DEFAULT '20.00' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliate_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "markup_percent_range" CHECK ("markup_percent" >= 0 AND "markup_percent" <= 1000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_affiliates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"affiliate_code_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_server_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"character_id" uuid,
	"privy_wallet_id" text NOT NULL,
	"address" text NOT NULL,
	"chain_type" text NOT NULL,
	"client_address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "affiliate_codes" ADD CONSTRAINT "affiliate_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_affiliates" ADD CONSTRAINT "user_affiliates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_affiliates" ADD CONSTRAINT "user_affiliates_affiliate_code_id_affiliate_codes_id_fk" FOREIGN KEY ("affiliate_code_id") REFERENCES "public"."affiliate_codes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_server_wallets" ADD CONSTRAINT "agent_server_wallets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_server_wallets" ADD CONSTRAINT "agent_server_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_server_wallets" ADD CONSTRAINT "agent_server_wallets_character_id_user_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."user_characters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "affiliate_codes_user_idx" ON "affiliate_codes" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "affiliate_codes_code_idx" ON "affiliate_codes" USING btree ("code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_affiliates_user_idx" ON "user_affiliates" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_affiliates_affiliate_idx" ON "user_affiliates" USING btree ("affiliate_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_organization_idx" ON "agent_server_wallets" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_user_idx" ON "agent_server_wallets" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_character_idx" ON "agent_server_wallets" USING btree ("character_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_privy_wallet_idx" ON "agent_server_wallets" USING btree ("privy_wallet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_address_idx" ON "agent_server_wallets" USING btree ("address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_server_wallets_client_address_idx" ON "agent_server_wallets" USING btree ("client_address");


CREATE TABLE IF NOT EXISTS "organization_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"billing_email" text,
	"tax_id_type" text,
	"tax_id_value" text,
	"billing_address" jsonb,
	"stripe_payment_method_id" text,
	"stripe_default_payment_method" text,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"auto_top_up_amount" numeric(12, 6),
	"auto_top_up_threshold" numeric(12, 6) DEFAULT '0.000000',
	"auto_top_up_subscription_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_billing_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"max_api_requests" integer DEFAULT 1000,
	"max_tokens_per_request" integer,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_config_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_encryption_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"encrypted_dek" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"algorithm" text DEFAULT 'aes-256-gcm' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp,
	CONSTRAINT "organization_encryption_keys_org_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"privy_user_id" text,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"anonymous_session_id" text,
	"expires_at" timestamp,
	"telegram_id" text,
	"telegram_username" text,
	"telegram_first_name" text,
	"telegram_photo_url" text,
	"phone_number" text,
	"phone_verified" boolean DEFAULT false,
	"discord_id" text,
	"discord_username" text,
	"discord_global_name" text,
	"discord_avatar_url" text,
	"whatsapp_id" text,
	"whatsapp_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_identities_privy_user_id_unique" UNIQUE("privy_user_id"),
	CONSTRAINT "user_identities_anonymous_session_id_unique" UNIQUE("anonymous_session_id"),
	CONSTRAINT "user_identities_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "user_identities_phone_number_unique" UNIQUE("phone_number"),
	CONSTRAINT "user_identities_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "user_identities_whatsapp_id_unique" UNIQUE("whatsapp_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"nickname" text,
	"work_function" text,
	"preferences" text,
	"response_notifications" boolean DEFAULT true,
	"email_notifications" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "app_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"features_enabled" jsonb DEFAULT '{"chat":true,"image":false,"video":false,"voice":false,"agents":false,"embedding":false}'::jsonb NOT NULL,
	"twitter_automation" jsonb DEFAULT '{"enabled":false,"autoPost":false,"autoReply":false,"autoEngage":false,"discovery":false,"postIntervalMin":90,"postIntervalMax":150}'::jsonb,
	"telegram_automation" jsonb DEFAULT '{"enabled":false,"autoReply":true,"autoAnnounce":false,"announceIntervalMin":120,"announceIntervalMax":240}'::jsonb,
	"discord_automation" jsonb DEFAULT '{"enabled":false,"autoAnnounce":false,"announceIntervalMin":120,"announceIntervalMax":240}'::jsonb,
	"promotional_assets" jsonb DEFAULT '[]'::jsonb,
	"linked_character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"github_repo" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"custom_pricing_enabled" boolean DEFAULT false NOT NULL,
	"monetization_enabled" boolean DEFAULT false NOT NULL,
	"inference_markup_percentage" numeric(7, 2) DEFAULT '0.00' NOT NULL,
	"purchase_share_percentage" numeric(5, 2) DEFAULT '10.00' NOT NULL,
	"platform_offset_amount" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"total_creator_earnings" numeric(12, 6) DEFAULT '0.000000' NOT NULL,
	"total_platform_revenue" numeric(12, 6) DEFAULT '0.000000' NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 60,
	"rate_limit_per_hour" integer DEFAULT 1000,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_database_uri" text,
	"user_database_project_id" text,
	"user_database_branch_id" text,
	"user_database_region" text DEFAULT 'aws-us-east-1',
	"user_database_status" "user_database_status" DEFAULT 'none' NOT NULL,
	"user_database_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_databases_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
ALTER TABLE IF EXISTS "org_feed_configs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "pending_reply_confirmations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "social_engagement_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "social_notification_messages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "domain_moderation_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_checkin_responses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_checkin_schedules" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_platform_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_platform_servers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_team_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "org_todos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE IF EXISTS "n8n_workflow"."credential_mappings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "org_feed_configs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pending_reply_confirmations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "social_engagement_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "social_notification_messages" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "domain_moderation_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_checkin_responses" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_checkin_schedules" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_platform_connections" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_platform_servers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_team_members" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "org_todos" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "n8n_workflow"."credential_mappings" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_anonymous_session_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "organizations_stripe_customer_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "organizations_auto_top_up_enabled_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_privy_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_anonymous_session_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_expires_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_work_function_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_telegram_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_phone_number_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "users_discord_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "apps_user_database_status_idx";--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "credit_balance" SET DATA TYPE numeric(16, 6);--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "credit_balance" SET DEFAULT '100.000000';--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "auto_top_up_enabled" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "auto_top_up_threshold" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "input_cost" SET DATA TYPE numeric(16, 6);--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "input_cost" SET DEFAULT '0.000000';--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "output_cost" SET DATA TYPE numeric(16, 6);--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "output_cost" SET DEFAULT '0.000000';--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "markup" SET DATA TYPE numeric(16, 6);--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "markup" SET DEFAULT '0.000000';--> statement-breakpoint
ALTER TABLE "credit_transactions" ALTER COLUMN "amount" SET DATA TYPE numeric(16, 6);--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "custom_pricing_enabled" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "inference_markup_percentage" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "inference_markup_percentage" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "purchase_share_percentage" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "purchase_share_percentage" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "platform_offset_amount" SET DATA TYPE real;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "platform_offset_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "total_creator_earnings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "total_platform_revenue" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "linked_character_ids" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "user_database_region" DROP DEFAULT;--> statement-breakpoint


ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "email_notifications" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "response_notifications" boolean DEFAULT true;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_billing_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_config_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_config" ADD CONSTRAINT "organization_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_encryption_keys_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_encryption_keys" ADD CONSTRAINT "organization_encryption_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_identities_user_id_users_id_fk') THEN ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_user_id_users_id_fk') THEN ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_config_app_id_apps_id_fk') THEN ALTER TABLE "app_config" ADD CONSTRAINT "app_config_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_billing_app_id_apps_id_fk') THEN ALTER TABLE "app_billing" ADD CONSTRAINT "app_billing_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_databases_app_id_apps_id_fk') THEN ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
CREATE INDEX IF NOT EXISTS "org_billing_organization_idx" ON "organization_billing" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_billing_stripe_customer_idx" ON "organization_billing" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_billing_auto_top_up_enabled_idx" ON "organization_billing" USING btree ("auto_top_up_enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_config_organization_idx" ON "organization_config" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_encryption_keys_org_idx" ON "organization_encryption_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_privy_user_id_idx" ON "user_identities" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_is_anonymous_idx" ON "user_identities" USING btree ("is_anonymous");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_anonymous_session_idx" ON "user_identities" USING btree ("anonymous_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_expires_at_idx" ON "user_identities" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_telegram_id_idx" ON "user_identities" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_phone_number_idx" ON "user_identities" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_discord_id_idx" ON "user_identities" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_identities_whatsapp_id_idx" ON "user_identities" USING btree ("whatsapp_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_preferences_user_idx" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_preferences_work_function_idx" ON "user_preferences" USING btree ("work_function");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "app_config_app_idx" ON "app_config" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_billing_app_idx" ON "app_billing" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_databases_app_idx" ON "app_databases" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_databases_status_idx" ON "app_databases" USING btree ("user_database_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_privy_idx" ON "users" USING btree ("privy_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_telegram_idx" ON "users" USING btree ("telegram_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_discord_idx" ON "users" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users" USING btree ("phone_number");--> statement-breakpoint

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "webhook_url";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "webhook_secret";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "tax_id_type";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "tax_id_value";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "billing_address";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "auto_top_up_subscription_id";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "max_api_requests";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "max_tokens_per_request";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "allowed_models";--> statement-breakpoint
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "allowed_providers";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "features_enabled";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "rate_limit_per_minute";--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "rate_limit_per_hour";--> statement-breakpoint

DROP TYPE IF EXISTS "public"."reply_confirmation_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."social_engagement_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_detected_by";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_severity";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."domain_event_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_agent_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_checkin_frequency";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_checkin_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_platform_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_platform_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_todo_priority";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."org_todo_status";--> statement-breakpoint
DROP SCHEMA IF EXISTS "n8n_workflow";

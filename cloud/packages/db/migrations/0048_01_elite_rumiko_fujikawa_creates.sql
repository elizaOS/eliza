
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
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


ALTER TABLE "apps" ADD COLUMN "email_notifications" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "response_notifications" boolean DEFAULT true;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_billing_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_config_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_config" ADD CONSTRAINT "organization_config_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_encryption_keys_organization_id_organizations_id_fk') THEN ALTER TABLE "organization_encryption_keys" ADD CONSTRAINT "organization_encryption_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_identities_user_id_users_id_fk') THEN ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_user_id_users_id_fk') THEN ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_config_app_id_apps_id_fk') THEN ALTER TABLE "app_config" ADD CONSTRAINT "app_config_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_billing_app_id_apps_id_fk') THEN ALTER TABLE "app_billing" ADD CONSTRAINT "app_billing_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_databases_app_id_apps_id_fk') THEN ALTER TABLE "app_databases" ADD CONSTRAINT "app_databases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;
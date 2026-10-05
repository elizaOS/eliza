CREATE TABLE IF NOT EXISTS "app_billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_account_key" text NOT NULL,
	"eligibility_principal_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_accounts_key_check" CHECK (length(btrim("app_billing_accounts"."external_account_key")) BETWEEN 1 AND 200)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_billing_members_role_check" CHECK ("app_billing_members"."role" IN ('administrator','member'))
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"product_family_key" text NOT NULL,
	"plan_key" text NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"interval" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"minimum_quantity" integer DEFAULT 1 NOT NULL,
	"maximum_quantity" integer NOT NULL,
	"trial_days" integer DEFAULT 7 NOT NULL,
	"trial_allowance_usd" numeric(16, 6) DEFAULT '0.000000' NOT NULL,
	"paid_allowance_usd" numeric(16, 6) DEFAULT '0.000000' NOT NULL,
	"expired_access" text NOT NULL,
	"entitlements" jsonb NOT NULL,
	"stripe_price_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_plan_revisions_access_check" CHECK ("app_billing_plan_revisions"."expired_access" IN ('read_only','denied')),
	CONSTRAINT "app_billing_plan_revisions_policy_check" CHECK ("app_billing_plan_revisions"."revision" > 0 AND "app_billing_plan_revisions"."amount_cents" > 0 AND "app_billing_plan_revisions"."currency" ~ '^[a-z]{3}$' AND "app_billing_plan_revisions"."interval" IN ('day','week','month','year') AND "app_billing_plan_revisions"."interval_count" > 0 AND "app_billing_plan_revisions"."minimum_quantity" > 0 AND "app_billing_plan_revisions"."maximum_quantity" >= "app_billing_plan_revisions"."minimum_quantity" AND "app_billing_plan_revisions"."trial_days" = 7 AND "app_billing_plan_revisions"."trial_allowance_usd" >= 0 AND "app_billing_plan_revisions"."paid_allowance_usd" >= 0),
	CONSTRAINT "app_billing_plan_revisions_identity_check" CHECK ("app_billing_plan_revisions"."stripe_price_id" ~ '^price_[A-Za-z0-9]+$' AND "app_billing_plan_revisions"."stripe_product_id" ~ '^prod_[A-Za-z0-9]+$' AND length(btrim("app_billing_plan_revisions"."product_family_key")) BETWEEN 1 AND 100 AND length(btrim("app_billing_plan_revisions"."plan_key")) BETWEEN 1 AND 100)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_merchants_provider_check" CHECK ("billing_merchants"."provider_account_key" = 'platform' OR "billing_merchants"."provider_account_key" ~ '^acct_[A-Za-z0-9]+$')
);

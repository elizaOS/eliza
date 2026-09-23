CREATE TABLE IF NOT EXISTS "app_billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_customers_customer_check" CHECK ("app_billing_customers"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$')
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"product_family_key" text NOT NULL,
	"fenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_billing_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_billing_seats_subject_check" CHECK (length(btrim("app_billing_seats"."subject")) BETWEEN 1 AND 200 AND length(btrim("app_billing_seats"."idempotency_key")) BETWEEN 8 AND 128)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_subscription_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscription_revision" bigint NOT NULL,
	"kind" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_outbox_revision_check" CHECK ("app_subscription_outbox"."subscription_revision" > 0)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_subscription_paid_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"provider_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_paid_periods_source_check" CHECK ("app_subscription_paid_periods"."stripe_invoice_id" ~ '^in_[A-Za-z0-9]+$' AND "app_subscription_paid_periods"."stripe_price_id" ~ '^price_[A-Za-z0-9]+$' AND "app_subscription_paid_periods"."quantity" > 0 AND "app_subscription_paid_periods"."period_end" > "app_subscription_paid_periods"."period_start" AND "app_subscription_paid_periods"."provider_digest" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_subscription_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"eligibility_principal_id" uuid NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"command_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_trials_duration_check" CHECK (extract(epoch FROM "app_subscription_trials"."ends_at" - "app_subscription_trials"."starts_at") = 604800)
);

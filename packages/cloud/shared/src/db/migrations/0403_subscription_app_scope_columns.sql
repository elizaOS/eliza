ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "plan_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "trial_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "trial_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "plan_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "target_quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "target_plan_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_event_receipts" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_event_receipts" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_subscription_incidents" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_incidents" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_billing_fences" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_billing_fences" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "access" text DEFAULT 'granted' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "features" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "grant_source" text DEFAULT 'paid_invoice' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "trial_claim_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "trial_claim_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_funding_allocations" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_funding_allocations" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_funding_reservations" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_funding_reservations" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;

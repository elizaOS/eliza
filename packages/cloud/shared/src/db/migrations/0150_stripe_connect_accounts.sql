-- Stripe Connect accounts (#8922) — fiat payout rail for creator earnings.
-- One row per creator who started Stripe Connect onboarding; the connected
-- account id is the transfers.create destination. Idempotent + guarded.
DO $$ BEGIN
  CREATE TYPE "stripe_connect_status" AS ENUM ('pending', 'active', 'restricted', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_connect_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_connect_account_id" text NOT NULL,
	"status" "stripe_connect_status" DEFAULT 'pending' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_connect_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "stripe_connect_accounts_account_id_unique" UNIQUE("stripe_connect_account_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stripe_connect_accounts" ADD CONSTRAINT "stripe_connect_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_connect_accounts_account_idx" ON "stripe_connect_accounts" USING btree ("stripe_connect_account_id");

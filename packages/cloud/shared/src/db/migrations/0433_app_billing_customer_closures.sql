CREATE TABLE IF NOT EXISTS "app_billing_customer_closures" (
	"customer_binding_id" uuid PRIMARY KEY NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"initiating_request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_customer_closures_shape" CHECK ("app_billing_customer_closures"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_customer_closures"."lifecycle_revision">0 AND "app_billing_customer_closures"."phase_generation">0 AND "app_billing_customer_closures"."stripe_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_customer_closures"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$')
);

--> statement-breakpoint
ALTER TABLE "app_billing_customer_closures" ADD CONSTRAINT "app_billing_customer_closures_customer_binding_id_app_billing_customers_id_fk" FOREIGN KEY ("customer_binding_id") REFERENCES "public"."app_billing_customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_customer_closures_account_merchant_idx" ON "app_billing_customer_closures" USING btree ("billing_account_id","merchant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_customer_closures_provider_idx" ON "app_billing_customer_closures" USING btree ("stripe_account_id","livemode","stripe_customer_id");

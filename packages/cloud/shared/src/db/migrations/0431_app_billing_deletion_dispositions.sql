CREATE TABLE IF NOT EXISTS "app_billing_deletion_dispositions" (
	"request_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"merchant_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_deletion_dispositions_request_id_scope_id_pk" PRIMARY KEY("request_id","scope_id"),
	CONSTRAINT "app_billing_deletion_dispositions_shape" CHECK ("app_billing_deletion_dispositions"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_deletion_dispositions"."lifecycle_revision">0 AND "app_billing_deletion_dispositions"."phase_generation">0 AND "app_billing_deletion_dispositions"."disposition" IN ('retain_shared','close'))
);
--> statement-breakpoint
ALTER TABLE "app_billing_deletion_dispositions" ADD CONSTRAINT "app_billing_deletion_dispositions_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
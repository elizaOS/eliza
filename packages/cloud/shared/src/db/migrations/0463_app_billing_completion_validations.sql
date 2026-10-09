CREATE TABLE "app_billing_completion_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"provider_receipt_digest" text NOT NULL,
	"validation_xid" "xid8" NOT NULL,
	"inventory_digest" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "app_billing_completion_validations_digest_check" CHECK ("app_billing_completion_validations"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_completion_validations"."provider_receipt_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_completion_validations"."inventory_digest" ~ '^[0-9a-f]{64}$')
);

--> statement-breakpoint
CREATE UNIQUE INDEX "app_billing_completion_validations_phase_xid_idx" ON "app_billing_completion_validations" USING btree ("phase_receipt_id","validation_xid");
--> statement-breakpoint
CREATE INDEX "app_billing_completion_validations_completed_xid_idx" ON "app_billing_completion_validations" USING btree ("validation_xid") WHERE "app_billing_completion_validations"."completed_at" IS NOT NULL;

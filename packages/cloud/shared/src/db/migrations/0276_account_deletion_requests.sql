CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"steward_user_id" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"execute_after" timestamp NOT NULL,
	"identity_deactivated_at" timestamp,
	"processing_started_at" timestamp,
	"completed_at" timestamp,
	"last_error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_requests_status_check" CHECK ("account_deletion_requests"."status" IN ('requested', 'scheduled', 'processing', 'completed', 'action_required')),
	CONSTRAINT "account_deletion_requests_attempts_check" CHECK ("account_deletion_requests"."attempts" >= 0 AND "account_deletion_requests"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX "account_deletion_requests_user_idx" ON "account_deletion_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_deletion_requests_due_idx" ON "account_deletion_requests" USING btree ("status","execute_after");--> statement-breakpoint
CREATE UNIQUE INDEX "account_deletion_requests_one_open_user_idx" ON "account_deletion_requests" USING btree ("user_id") WHERE "account_deletion_requests"."completed_at" IS NULL AND "account_deletion_requests"."user_id" IS NOT NULL;

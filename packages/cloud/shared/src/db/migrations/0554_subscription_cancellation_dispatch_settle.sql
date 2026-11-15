ALTER TABLE "billing_subscription_commands" ADD COLUMN "cancellation_dispatched_at" timestamp with time zone;
--> statement-breakpoint
-- An uncertain command fenced before this column existed starts its settle
-- window now, which is later than its real dispatch and so never too early.
UPDATE "billing_subscription_commands" SET "cancellation_dispatched_at" = clock_timestamp()
 WHERE "cancellation_dispatch_state" = 'started' AND "status" = 'OUTCOME_UNKNOWN';
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_cancellation_dispatched_at_check" CHECK ("billing_subscription_commands"."cancellation_dispatched_at" IS NULL OR "billing_subscription_commands"."cancellation_dispatch_state" = 'started');

ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT "billing_subscription_commands_cancellation_dispatch_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT "billing_subscription_commands_cancellation_result_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT "billing_subscription_commands_status_shape_check";
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD COLUMN "schedule_predecessor_command_id" uuid;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_schedule_predecessor_tenant_fk" FOREIGN KEY ("schedule_predecessor_command_id","organization_id") REFERENCES "billing_subscription_commands"("id","organization_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_schedule_predecessor_check" CHECK (("billing_subscription_commands"."schedule_predecessor_command_id" IS NULL OR ("billing_subscription_commands"."kind" IN ('cancel','resume') AND "billing_subscription_commands"."schedule_predecessor_command_id" <> "billing_subscription_commands"."id")) AND ("billing_subscription_commands"."kind" <> 'resume' OR ("billing_subscription_commands"."cancellation_dispatch_state" IS NULL AND "billing_subscription_commands"."status" <> 'APPLIED') OR "billing_subscription_commands"."schedule_predecessor_command_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_cancellation_dispatch_check" CHECK ("billing_subscription_commands"."cancellation_dispatch_state" IS NULL OR ("billing_subscription_commands"."kind" IN ('cancel','resume') AND "billing_subscription_commands"."cancellation_dispatch_state" IN ('ready','started')));
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_cancellation_result_check" CHECK (("billing_subscription_commands"."kind" IN ('cancel','resume') AND "billing_subscription_commands"."status" = 'APPLIED' AND "billing_subscription_commands"."result_subscription_id" IS NOT NULL AND "billing_subscription_commands"."subscription_id" IS NOT NULL AND "billing_subscription_commands"."result_subscription_id" = "billing_subscription_commands"."subscription_id" AND "billing_subscription_commands"."result_subscription_revision" IS NOT NULL AND "billing_subscription_commands"."result_subscription_revision" > 0) OR (("billing_subscription_commands"."kind" NOT IN ('cancel','resume') OR "billing_subscription_commands"."status" <> 'APPLIED') AND "billing_subscription_commands"."result_subscription_revision" IS NULL));
--> statement-breakpoint
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_status_shape_check" CHECK (("billing_subscription_commands"."status" = 'PREPARED' AND "billing_subscription_commands"."execution_generation" = 0 AND "billing_subscription_commands"."provider_started_at" IS NULL AND "billing_subscription_commands"."provider_response_digest" IS NULL AND "billing_subscription_commands"."error_code" IS NULL AND "billing_subscription_commands"."completed_at" IS NULL AND "billing_subscription_commands"."result_subscription_id" IS NULL AND "billing_subscription_commands"."applied_at" IS NULL) OR ("billing_subscription_commands"."status" = 'OUTCOME_UNKNOWN' AND "billing_subscription_commands"."execution_generation" > 0 AND "billing_subscription_commands"."provider_started_at" IS NOT NULL AND "billing_subscription_commands"."provider_response_digest" IS NULL AND "billing_subscription_commands"."completed_at" IS NULL AND "billing_subscription_commands"."result_subscription_id" IS NULL AND "billing_subscription_commands"."applied_at" IS NULL) OR ("billing_subscription_commands"."status" = 'SUCCEEDED' AND "billing_subscription_commands"."execution_generation" > 0 AND "billing_subscription_commands"."provider_started_at" IS NOT NULL AND "billing_subscription_commands"."provider_response_digest" IS NOT NULL AND "billing_subscription_commands"."error_code" IS NULL AND "billing_subscription_commands"."completed_at" IS NOT NULL AND "billing_subscription_commands"."result_subscription_id" IS NULL AND "billing_subscription_commands"."applied_at" IS NULL) OR ("billing_subscription_commands"."status" = 'APPLIED' AND "billing_subscription_commands"."kind" IN ('checkout','cancel','resume') AND "billing_subscription_commands"."execution_generation" > 0 AND "billing_subscription_commands"."provider_started_at" IS NOT NULL AND "billing_subscription_commands"."provider_response_digest" IS NOT NULL AND "billing_subscription_commands"."error_code" IS NULL AND "billing_subscription_commands"."completed_at" IS NOT NULL AND "billing_subscription_commands"."result_subscription_id" IS NOT NULL AND "billing_subscription_commands"."applied_at" IS NOT NULL) OR ("billing_subscription_commands"."status" = 'FAILED' AND "billing_subscription_commands"."execution_generation" > 0 AND "billing_subscription_commands"."provider_started_at" IS NOT NULL AND "billing_subscription_commands"."error_code" IS NOT NULL AND "billing_subscription_commands"."completed_at" IS NOT NULL AND "billing_subscription_commands"."result_subscription_id" IS NULL AND "billing_subscription_commands"."applied_at" IS NULL) OR ("billing_subscription_commands"."status" = 'SUPERSEDED' AND "billing_subscription_commands"."execution_generation" = 0 AND "billing_subscription_commands"."provider_started_at" IS NULL AND "billing_subscription_commands"."provider_response_digest" IS NULL AND "billing_subscription_commands"."error_code" IS NOT NULL AND "billing_subscription_commands"."completed_at" IS NOT NULL AND "billing_subscription_commands"."result_subscription_id" IS NULL AND "billing_subscription_commands"."applied_at" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_applied_subscription_cancellation_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.kind IN ('cancel','resume') AND OLD.status='APPLIED' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'applied subscription schedule result is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_subscription_schedule_predecessor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.schedule_predecessor_command_id IS DISTINCT FROM OLD.schedule_predecessor_command_id THEN
  RAISE EXCEPTION 'subscription schedule predecessor is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER billing_subscription_schedule_predecessor_guard BEFORE UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_subscription_schedule_predecessor();

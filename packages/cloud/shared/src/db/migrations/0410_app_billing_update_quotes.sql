CREATE TABLE "app_billing_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscription_revision" bigint NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_preview" jsonb NOT NULL,
	"digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_by_command_id" uuid,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "app_billing_quotes_shape_check" CHECK ("app_billing_quotes"."subscription_revision" > 0 AND "app_billing_quotes"."quantity" > 0 AND "app_billing_quotes"."digest" ~ '^[0-9a-f]{64}$' AND "app_billing_quotes"."expires_at" > "app_billing_quotes"."created_at" AND ("app_billing_quotes"."consumed_by_command_id" IS NULL) = ("app_billing_quotes"."consumed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_consumed_by_command_id_billing_subscription_commands_id_fk" FOREIGN KEY ("consumed_by_command_id") REFERENCES "billing_subscription_commands"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_scope_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "app_billing_quotes_scope_created_idx" ON "app_billing_quotes" USING btree ("billing_scope_id","created_at");
--> statement-breakpoint
CREATE FUNCTION validate_app_billing_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; subscription record; plan record; command record;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['consumed_by_command_id','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_by_command_id','consumed_at']) THEN RAISE EXCEPTION 'Billing quote identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.consumed_by_command_id IS NOT NULL AND ROW(NEW.consumed_by_command_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.consumed_by_command_id,OLD.consumed_at) THEN RAISE EXCEPTION 'Billing quote already consumed'; END IF;
  SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
  SELECT * INTO subscription FROM billing_subscriptions WHERE id = NEW.subscription_id;
  SELECT * INTO plan FROM app_billing_plan_revisions WHERE id = NEW.plan_revision_id;
  IF (sc.app_id,sc.merchant_id,sc.livemode) IS DISTINCT FROM (NEW.app_id,NEW.merchant_id,NEW.livemode) OR subscription.billing_scope_id IS DISTINCT FROM sc.id OR (plan.app_id,plan.merchant_id,plan.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) THEN RAISE EXCEPTION 'Billing quote authority mismatch'; END IF;
  IF NEW.quantity NOT BETWEEN plan.minimum_quantity AND plan.maximum_quantity OR NEW.subscription_revision <> subscription.lifecycle_revision THEN RAISE EXCEPTION 'Billing quote source revision or quantity invalid'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'New billing quote must be live and unconsumed'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
    SELECT * INTO command FROM billing_subscription_commands WHERE id = NEW.consumed_by_command_id;
    IF NEW.expires_at <= clock_timestamp() OR NEW.consumed_at > clock_timestamp() OR (command.billing_scope_id,command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_revision_id,command.target_quantity) IS DISTINCT FROM (NEW.billing_scope_id,NEW.actor_user_id,NEW.subscription_id,NEW.subscription_revision,NEW.plan_revision_id,NEW.quantity) OR NOT COALESCE(command.request_payload->>'action' = 'update' AND command.request_payload->>'quoteId' = NEW.id::text,false) THEN RAISE EXCEPTION 'Billing quote consumption requires exact unexpired command'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_quotes_source BEFORE INSERT OR UPDATE ON app_billing_quotes FOR EACH ROW EXECUTE FUNCTION validate_app_billing_quote();

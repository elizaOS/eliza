ALTER TABLE "billing_merchants" ADD COLUMN "stripe_account_id" text;
--> statement-breakpoint
ALTER TABLE "billing_merchants" ADD COLUMN "connection_revision" bigint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_merchants" ADD COLUMN "disconnected_at" timestamp with time zone;
--> statement-breakpoint
DROP TRIGGER billing_merchants_app_source ON billing_merchants;
--> statement-breakpoint
UPDATE billing_merchants SET stripe_account_id = provider_account_key WHERE provider_account_key <> 'platform';
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_merchants_actual_account_mode_idx" ON "billing_merchants" USING btree ("stripe_account_id","livemode") WHERE "billing_merchants"."stripe_account_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "billing_merchants" ADD CONSTRAINT "billing_merchants_connection_check" CHECK ("billing_merchants"."connection_revision" > 0 AND ("billing_merchants"."stripe_account_id" IS NULL OR "billing_merchants"."stripe_account_id" ~ '^acct_[A-Za-z0-9]+$') AND ("billing_merchants"."provider_account_key" = 'platform' OR "billing_merchants"."stripe_account_id" IS NULL OR "billing_merchants"."provider_account_key" = "billing_merchants"."stripe_account_id") AND ("billing_merchants"."disconnected_at" IS NULL OR NOT "billing_merchants"."enabled"));
--> statement-breakpoint
CREATE FUNCTION validate_app_billing_merchant_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['enabled','connection_revision','disconnected_at','stripe_account_id']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['enabled','connection_revision','disconnected_at','stripe_account_id']) OR (OLD.stripe_account_id IS NOT NULL AND OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id) THEN RAISE EXCEPTION 'Billing merchant identity is immutable'; END IF;
    NEW.connection_revision := OLD.connection_revision + 1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER billing_merchants_connection_authority BEFORE INSERT OR UPDATE ON billing_merchants FOR EACH ROW EXECUTE FUNCTION validate_app_billing_merchant_connection();

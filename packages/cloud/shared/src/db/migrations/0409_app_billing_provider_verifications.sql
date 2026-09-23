CREATE TABLE "app_billing_catalog_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_account_id" text NOT NULL,
	"object_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"api_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "app_catalog_verifications_proof_check" CHECK ("app_billing_catalog_verifications"."provider_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_catalog_verifications"."object_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_catalog_verifications"."input_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_catalog_verifications"."api_version" = '2024-11-20.acacia')
);
--> statement-breakpoint
CREATE TABLE "app_billing_merchant_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_account_id" text NOT NULL,
	"object_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"api_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "app_merchant_verifications_proof_check" CHECK ("app_billing_merchant_verifications"."provider_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_merchant_verifications"."object_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_merchant_verifications"."input_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_merchant_verifications"."api_version" = '2024-11-20.acacia')
);
--> statement-breakpoint
ALTER TABLE "app_billing_catalog_verifications" ADD CONSTRAINT "app_billing_catalog_verifications_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_catalog_verifications" ADD CONSTRAINT "app_catalog_verifications_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_billing_merchant_verifications" ADD CONSTRAINT "app_merchant_verifications_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "app_catalog_verifications_recent_idx" ON "app_billing_catalog_verifications" USING btree ("plan_revision_id","created_at");
--> statement-breakpoint
CREATE INDEX "app_merchant_verifications_recent_idx" ON "app_billing_merchant_verifications" USING btree ("merchant_id","created_at");
--> statement-breakpoint
CREATE FUNCTION validate_app_billing_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merchant record; plan record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Billing verification observations are immutable'; END IF;
  SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
  IF (merchant.stripe_account_id,merchant.livemode) IS DISTINCT FROM (NEW.provider_account_id,NEW.livemode) THEN RAISE EXCEPTION 'Billing verification merchant mismatch'; END IF;
  IF TG_TABLE_NAME = 'app_billing_merchant_verifications' AND NEW.value->>'accountId' IS DISTINCT FROM NEW.provider_account_id THEN RAISE EXCEPTION 'Billing verification account mismatch'; END IF;
  IF TG_TABLE_NAME = 'app_billing_catalog_verifications' THEN
    SELECT * INTO plan FROM app_billing_plan_revisions WHERE id = NEW.plan_revision_id;
    IF plan.merchant_id IS DISTINCT FROM NEW.merchant_id OR (NEW.value->>'planRevisionId',NEW.value->>'priceId',NEW.value->>'productId') IS DISTINCT FROM (plan.id::text,plan.stripe_price_id,plan.stripe_product_id) THEN RAISE EXCEPTION 'Billing verification plan mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_merchant_verifications_immutable BEFORE INSERT OR UPDATE OR DELETE ON app_billing_merchant_verifications FOR EACH ROW EXECUTE FUNCTION validate_app_billing_verification();
--> statement-breakpoint
CREATE TRIGGER app_billing_catalog_verifications_immutable BEFORE INSERT OR UPDATE OR DELETE ON app_billing_catalog_verifications FOR EACH ROW EXECUTE FUNCTION validate_app_billing_verification();

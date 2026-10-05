CREATE TABLE IF NOT EXISTS app_billing_application_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_key text NOT NULL,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL REFERENCES billing_merchants(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL, product_family_key text NOT NULL, manifest_digest text NOT NULL,
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_billing_application_slots_shape CHECK (slot_key ~ '^[a-z][a-z0-9_-]{0,99}$' AND length(btrim(product_family_key)) BETWEEN 1 AND 100 AND manifest_digest ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_application_slots_active_idx ON app_billing_application_slots(slot_key,livemode) WHERE disabled_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_application_slots_manifest_idx ON app_billing_application_slots(manifest_digest);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_app_billing_application_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Application slot history is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'disabled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'disabled_at') OR OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL) THEN RAISE EXCEPTION 'Application slots can only be disabled once'; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id = a.organization_id WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id AND m.id = NEW.merchant_id AND m.livemode = NEW.livemode) THEN RAISE EXCEPTION 'Application slot owner or merchant environment mismatch'; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM app_billing_plan_revisions p WHERE p.app_id = NEW.app_id AND p.merchant_id = NEW.merchant_id AND p.product_family_key = NEW.product_family_key AND p.published_at IS NOT NULL AND p.retired_at IS NULL AND p.trial_days = 7) THEN RAISE EXCEPTION 'Application slot requires a published seven-day trial catalog'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS app_billing_application_slots_authority ON app_billing_application_slots;
CREATE TRIGGER app_billing_application_slots_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_application_slots FOR EACH ROW EXECUTE FUNCTION validate_app_billing_application_slot();

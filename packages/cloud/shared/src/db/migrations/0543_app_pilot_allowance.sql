-- Sponsored access uses the existing allowance/reservation ledgers, never invented Stripe records.
ALTER TABLE subscription_allowance_periods
  ALTER COLUMN subscription_id DROP NOT NULL,
  ALTER COLUMN subscription_revision DROP NOT NULL,
  ADD COLUMN pilot_redemption_id uuid REFERENCES app_pilot_redemptions(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods DROP CONSTRAINT subscription_allowance_periods_invoice_id_check;
ALTER TABLE subscription_allowance_periods ADD CONSTRAINT subscription_allowance_periods_invoice_id_check CHECK (
  provider_environment IN ('test','live') AND (
    (provider = 'stripe' AND promo_grant_id IS NULL AND pilot_redemption_id IS NULL AND subscription_id IS NOT NULL AND subscription_revision IS NOT NULL AND (
      (grant_source = 'paid_invoice' AND stripe_invoice_id IS NOT NULL AND stripe_invoice_id ~ '^in_[A-Za-z0-9]+$' AND trial_claim_id IS NULL)
      OR (grant_source = 'trial_claim' AND billing_scope_id IS NOT NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NOT NULL)))
    OR (provider = 'eliza' AND grant_source = 'promo_grant' AND promo_grant_id IS NOT NULL AND pilot_redemption_id IS NULL
      AND billing_scope_id IS NULL AND merchant_key = 'platform' AND subscription_id IS NULL
      AND subscription_revision IS NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NULL)
    OR (provider = 'pilot' AND grant_source = 'pilot' AND promo_grant_id IS NULL AND pilot_redemption_id IS NOT NULL AND billing_scope_id IS NOT NULL
      AND subscription_id IS NULL AND subscription_revision IS NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NULL)
  )
);
CREATE UNIQUE INDEX subscription_allowance_periods_pilot_month_idx ON subscription_allowance_periods(pilot_redemption_id,period_start) WHERE pilot_redemption_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE app_pilot_activations (
  redemption_id uuid PRIMARY KEY REFERENCES app_pilot_redemptions(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER app_pilot_activations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_pilot_activations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION validate_app_pilot_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; sc record; p record; i integer; expected_start timestamptz; expected_end timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.pilot_redemption_id IS DISTINCT FROM OLD.pilot_redemption_id OR
    (OLD.pilot_redemption_id IS NOT NULL AND
      ROW(NEW.organization_id,NEW.merchant_key,NEW.provider,NEW.provider_environment,NEW.grant_source,NEW.plan_key,NEW.catalog_version,NEW.period_start,NEW.period_end,NEW.expires_at,NEW.granted_amount,NEW.adjustment_amount)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.merchant_key,OLD.provider,OLD.provider_environment,OLD.grant_source,OLD.plan_key,OLD.catalog_version,OLD.period_start,OLD.period_end,OLD.expires_at,OLD.granted_amount,OLD.adjustment_amount))) THEN
    RAISE EXCEPTION 'Pilot allowance terms are immutable';
  END IF;
  IF NEW.pilot_redemption_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM app_pilot_redemptions WHERE id=NEW.pilot_redemption_id;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=r.billing_scope_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=r.plan_revision_id;
  IF r.id IS NULL OR sc.id IS NULL OR p.id IS NULL OR
    (r.app_id,r.livemode,r.billing_scope_id) IS DISTINCT FROM (sc.app_id,sc.livemode,NEW.billing_scope_id) OR
    (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) OR
    NEW.organization_id <> sc.organization_id OR NEW.plan_key <> p.plan_key OR NEW.catalog_version <> p.id::text OR
    NEW.granted_amount <> p.paid_allowance_usd OR NEW.adjustment_amount <> 0 OR p.interval <> 'month' OR p.interval_count <> 1 THEN
    RAISE EXCEPTION 'Pilot allowance source mismatch';
  END IF;
  FOR i IN 0..5 LOOP
    expected_start := ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC';
    expected_end := ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => i+1)) AT TIME ZONE 'UTC';
    IF NEW.period_start = expected_start AND NEW.period_end = expected_end THEN RETURN NEW; END IF;
  END LOOP;
  RAISE EXCEPTION 'Pilot allowance period is not an original calendar month';
END $$;
CREATE TRIGGER subscription_allowance_periods_pilot_source BEFORE INSERT OR UPDATE ON subscription_allowance_periods
  FOR EACH ROW EXECUTE FUNCTION validate_app_pilot_allowance();
--> statement-breakpoint
CREATE FUNCTION validate_app_pilot_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; n integer;
BEGIN
  SELECT * INTO r FROM app_pilot_redemptions WHERE id=NEW.redemption_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=r.plan_revision_id;
  SELECT count(*) INTO n FROM subscription_allowance_periods WHERE pilot_redemption_id=r.id;
  IF r.id IS NULL OR p.id IS NULL OR n <> (CASE WHEN p.paid_allowance_usd > 0 THEN 6 ELSE 0 END) THEN
    RAISE EXCEPTION 'Pilot activation requires complete monthly allowance publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_pilot_activations_complete BEFORE INSERT ON app_pilot_activations
  FOR EACH ROW EXECUTE FUNCTION validate_app_pilot_activation();

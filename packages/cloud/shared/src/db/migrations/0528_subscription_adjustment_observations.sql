CREATE TABLE subscription_adjustment_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL REFERENCES subscription_allowance_transactions(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  previous_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  observation jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_adjustment_request_unique UNIQUE(grant_id,request_id),
  CONSTRAINT subscription_adjustment_version_unique UNIQUE(grant_id,version),
  CONSTRAINT subscription_adjustment_observation_shape CHECK ((
    jsonb_typeof(observation)='object'
    AND observation->>'kind'='renewal_adjustment_observation'
    AND observation->>'version'='1'
    AND observation->>'organizationId'=organization_id::text
    AND observation->>'digest' ~ '^[a-f0-9]{64}$'
    AND observation->>'grantDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'invoiceAuthorityDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'invoiceDetailsDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'settlementDetailsDigest' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(observation->'observation')='object'
    AND observation-ARRAY['kind','version','organizationId','subscriptionId','invoiceAuthorityDigest','invoiceDetailsDigest','settlementDetailsDigest','grantDigest','observation','digest']='{}'::jsonb
    AND isfinite(observed_at) AND observed_at<=recorded_at
  ) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION guard_subscription_adjustment_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row subscription_allowance_transactions%ROWTYPE;
DECLARE period_row subscription_allowance_periods%ROWTYPE;
DECLARE previous_row subscription_adjustment_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'subscription adjustment observations are append only'; END IF;
  -- Same organization lock as funding publication; never hold it during provider reads.
  PERFORM id FROM organizations WHERE id=NEW.organization_id AND is_active=true
    AND account_lifecycle_state='active' AND account_deletion_request_id IS NULL
    AND paid_work_fenced_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription adjustment organization fenced'; END IF;
  SELECT * INTO grant_row FROM subscription_allowance_transactions WHERE id=NEW.grant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription adjustment grant missing'; END IF;
  SELECT * INTO period_row FROM subscription_allowance_periods WHERE id=grant_row.allowance_period_id;
  IF NOT FOUND OR period_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR period_row.billing_scope_id IS NOT NULL OR period_row.merchant_key IS DISTINCT FROM 'platform'
    OR period_row.grant_source IS DISTINCT FROM 'paid_invoice'
    OR grant_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR grant_row.kind IS DISTINCT FROM 'grant' OR grant_row.billing_scope_id IS NOT NULL
    OR grant_row.merchant_key IS DISTINCT FROM 'platform'
    OR period_row.subscription_id::text IS DISTINCT FROM NEW.observation->>'subscriptionId'
    OR grant_row.request_digest IS DISTINCT FROM NEW.observation->>'grantDigest'
    OR grant_row.metadata->'renewalInvoiceAuthority'->>'digest' IS DISTINCT FROM NEW.observation->>'invoiceAuthorityDigest'
    OR grant_row.metadata->'renewalInvoiceDetails'->>'digest' IS DISTINCT FROM NEW.observation->>'invoiceDetailsDigest'
    OR grant_row.metadata->'renewalSettlementDetails'->>'digest' IS DISTINCT FROM NEW.observation->>'settlementDetailsDigest'
    OR period_row.stripe_invoice_id IS DISTINCT FROM NEW.observation->'observation'->'invoice'->>'id'
  THEN RAISE EXCEPTION 'subscription adjustment original grant mismatch'; END IF;
  SELECT * INTO previous_row FROM subscription_adjustment_observations WHERE grant_id=NEW.grant_id ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.previous_id IS DISTINCT FROM previous_row.id OR NEW.version<>previous_row.version+1
      OR NEW.observed_at<previous_row.observed_at
    THEN RAISE EXCEPTION 'subscription adjustment stale predecessor'; END IF;
  ELSIF NEW.previous_id IS NOT NULL OR NEW.version<>1 THEN
    RAISE EXCEPTION 'subscription adjustment initial predecessor mismatch';
  END IF;
  NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_adjustment_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_adjustment_observations FOR EACH ROW EXECUTE FUNCTION guard_subscription_adjustment_observation();

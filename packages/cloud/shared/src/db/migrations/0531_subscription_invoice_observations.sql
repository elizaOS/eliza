CREATE TABLE subscription_invoice_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  request_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  previous_id uuid REFERENCES subscription_invoice_observations(id) ON DELETE RESTRICT,
  observation jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(receipt_id,organization_id) REFERENCES billing_subscription_event_receipts(id,organization_id) ON DELETE RESTRICT,
  CHECK ((jsonb_typeof(observation)='object' AND observation->>'kind'='retained_invoice_balance_observation'
    AND observation->>'version'='1' AND observation->>'digest' ~ '^[a-f0-9]{64}$'
    AND observation->>'organizationId'=organization_id::text) IS TRUE)
);
CREATE UNIQUE INDEX subscription_invoice_observation_request_unique ON subscription_invoice_observations(receipt_id,request_id);
CREATE UNIQUE INDEX subscription_invoice_observation_version_unique ON subscription_invoice_observations(receipt_id,version);
--> statement-breakpoint
CREATE FUNCTION guard_subscription_invoice_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE original jsonb;
DECLARE head subscription_invoice_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice observations are immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  IF NOT FOUND OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.status<>'processing' OR receipt.lease_token IS DISTINCT FROM NEW.request_id
    OR receipt.lease_expires_at IS NULL OR receipt.lease_expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'invoice observation lease mismatch'; END IF;
  SELECT evidence INTO original FROM subscription_invoice_event_evidence
    WHERE receipt_id=NEW.receipt_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR (NEW.observation->>'originalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
    OR (NEW.observation->>'subscriptionId') IS DISTINCT FROM (original->'scope'->>'subscriptionId')
    OR (NEW.observation->>'invoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
    OR (NEW.observation->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
    OR (NEW.observation->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
  THEN RAISE EXCEPTION 'invoice observation original owner mismatch'; END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_invoice_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_invoice_observations
FOR EACH ROW EXECUTE FUNCTION guard_subscription_invoice_observation();

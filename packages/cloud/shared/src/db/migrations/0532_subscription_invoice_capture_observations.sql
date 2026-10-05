ALTER TABLE subscription_invoice_observations DROP CONSTRAINT subscription_invoice_observations_check;
ALTER TABLE subscription_invoice_observations ADD CONSTRAINT subscription_invoice_observations_payload_check CHECK ((
  jsonb_typeof(observation)='object' AND observation->>'version'='1'
  AND observation->>'digest' ~ '^[a-f0-9]{64}$' AND observation->>'organizationId'=organization_id::text
  AND (
    observation->>'kind'='retained_invoice_balance_observation'
    OR (observation->>'kind'='retained_collecting_invoice_capture'
      AND jsonb_typeof(observation->'balance')='object'
      AND observation->'balance'->>'kind'='retained_invoice_balance_observation'
      AND observation->'balance'->>'version'='1'
      AND observation->'balance'->>'digest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(observation->'payment')='object' AND observation->'payment'->>'id' ~ '^pi_[A-Za-z0-9]+$'
      AND jsonb_typeof(observation->'charge')='object' AND observation->'charge'->>'id' ~ '^ch_[A-Za-z0-9]+$'
      AND observation->'balance'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'balance'->>'organizationId'=observation->>'organizationId'
      AND observation->'balance'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'balance'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'balance'->>'customerId'=observation->>'customerId'
      AND observation->'balance'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'balance'->>'livemode'=observation->>'livemode'
      AND observation->'balance'->>'currency'=observation->>'currency'
    )
  )
) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_subscription_invoice_observation() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.observation->>'kind'='retained_collecting_invoice_capture' AND (
    COALESCE((original->'event'->'data'->'object'->>'starting_balance')::numeric,0)<=0
    OR COALESCE((original->'event'->'data'->'object'->>'amount_due')::numeric,0)<=0
    OR (NEW.observation->'payment'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'payment_intent')
    OR (NEW.observation->'charge'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'charge')
    OR (NEW.observation->'payment'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.observation->'charge'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.observation->'payment'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->'charge'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->'payment'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.observation->'charge'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.observation->'payment'->>'amount_received')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
    OR (NEW.observation->'charge'->>'amount_captured')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
  ) THEN RAISE EXCEPTION 'collecting capture original payment mismatch'; END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;

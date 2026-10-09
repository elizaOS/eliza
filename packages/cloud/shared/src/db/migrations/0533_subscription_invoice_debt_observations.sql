ALTER TABLE subscription_invoice_observations DROP CONSTRAINT subscription_invoice_observations_payload_check;
ALTER TABLE subscription_invoice_observations ADD CONSTRAINT subscription_invoice_observations_payload_check CHECK ((
  jsonb_typeof(observation)='object' AND observation->>'version'='1'
  AND observation->>'digest' ~ '^[a-f0-9]{64}$' AND observation->>'organizationId'=organization_id::text
  AND (
    observation->>'kind'='retained_invoice_balance_observation'
    OR (observation->>'kind'='observed_original_invoice_debt'
      AND observation->'capture'->>'kind'='retained_collecting_invoice_capture'
      AND observation->'capture'->>'version'='1'
      AND observation->'capture'->'balance'->>'kind'='retained_invoice_balance_observation'
      AND observation->'capture'->'balance'->>'version'='1'
      AND observation->'capture'->'balance'->>'digest' ~ '^[a-f0-9]{64}$'
      AND observation->'capture'->'balance'->>'organizationId'=observation->>'organizationId'
      AND observation->'capture'->'balance'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'capture'->'balance'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'capture'->'balance'->>'customerId'=observation->>'customerId'
      AND observation->'capture'->'balance'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'capture'->'balance'->>'livemode'=observation->>'livemode'
      AND observation->'capture'->'balance'->>'currency'=observation->>'currency'
      AND observation->'capture'->'balance'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'organizationId'=observation->>'organizationId'
      AND observation->'capture'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'capture'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'capture'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'capture'->>'customerId'=observation->>'customerId'
      AND observation->'capture'->>'livemode'=observation->>'livemode'
      AND observation->'capture'->>'digest' ~ '^[a-f0-9]{64}$'
      AND observation->>'collectorOriginalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'currency'=observation->>'currency'
      AND observation->'trace'->>'currency'=observation->>'currency'
      AND observation->'trace'->>'kind'='original_invoice_debt_trace'
      AND observation->'trace'->>'version'='1'
      AND observation->'trace'->>'digest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(observation->'originals')='array'
      AND jsonb_array_length(observation->'originals')>0
    )
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
DECLARE capture jsonb;
DECLARE contributor jsonb;
DECLARE original_digest text;
DECLARE retained jsonb;
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
  capture := CASE WHEN NEW.observation->>'kind'='observed_original_invoice_debt' THEN NEW.observation->'capture' ELSE NEW.observation END;
  IF NEW.observation->>'kind' IN ('retained_collecting_invoice_capture','observed_original_invoice_debt') AND (
    COALESCE((original->'event'->'data'->'object'->>'starting_balance')::numeric,0)<=0
    OR COALESCE((original->'event'->'data'->'object'->>'amount_due')::numeric,0)<=0
    OR (capture->'payment'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'payment_intent')
    OR (capture->'charge'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'charge')
    OR (capture->'payment'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (capture->'charge'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (capture->'payment'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (capture->'charge'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (capture->'payment'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (capture->'charge'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (capture->'payment'->>'amount_received')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
    OR (capture->'charge'->>'amount_captured')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
  ) THEN RAISE EXCEPTION 'collecting capture original payment mismatch'; END IF;
  IF NEW.observation->>'kind'='observed_original_invoice_debt' THEN
    IF (NEW.observation->>'currency') IS DISTINCT FROM (original->'event'->'data'->'object'->>'currency')
      OR (NEW.observation->'trace'->>'organizationId') IS DISTINCT FROM NEW.organization_id::text
      OR (NEW.observation->'trace'->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
      OR (NEW.observation->'trace'->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
      OR (NEW.observation->'trace'->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
      OR (NEW.observation->'trace'->>'collectorInvoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
      OR (NEW.observation->'trace'->>'collectorOriginalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
      OR (NEW.observation->'trace'->>'carriedDebit')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'starting_balance')::numeric
      OR (NEW.observation->'trace'->>'collectorInvoiceTotal')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'total')::numeric
      OR (NEW.observation->'trace'->>'expectedAmountDue')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
      OR (SELECT sum((c->>'amount')::numeric) FROM jsonb_array_elements(NEW.observation->'trace'->'components') c) IS DISTINCT FROM (original->'event'->'data'->'object'->>'starting_balance')::numeric
      OR (capture->'balance'->'invoice') IS DISTINCT FROM (original->'event'->'data'->'object')
      OR jsonb_typeof(NEW.observation->'trace'->'components') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.observation->'trace'->'components')<>jsonb_array_length(NEW.observation->'originals')
      OR (SELECT count(DISTINCT value->>'invoiceId') FROM jsonb_array_elements(NEW.observation->'originals'))<>jsonb_array_length(NEW.observation->'originals')
    THEN RAISE EXCEPTION 'debt attribution shape mismatch'; END IF;
    FOR contributor IN SELECT value FROM jsonb_array_elements(NEW.observation->'originals') LOOP
      IF jsonb_typeof(contributor->'originalEvidenceDigests') IS DISTINCT FROM 'array'
        OR jsonb_array_length(contributor->'originalEvidenceDigests')=0
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.observation->'trace'->'components') c
          WHERE c->>'invoiceId'=contributor->>'invoiceId' AND c->'originalEvidenceDigests'=contributor->'originalEvidenceDigests')
      THEN RAISE EXCEPTION 'debt contributor trace mismatch'; END IF;
      FOR original_digest IN SELECT jsonb_array_elements_text(contributor->'originalEvidenceDigests') LOOP
        SELECT evidence INTO retained FROM subscription_invoice_event_evidence
          WHERE organization_id=NEW.organization_id AND evidence->>'digest'=original_digest
          AND evidence->'scope'->>'invoiceId'=contributor->>'invoiceId'
          AND evidence->'scope'->>'providerAccountId'=original->'scope'->>'providerAccountId'
          AND evidence->'scope'->>'customerId'=original->'scope'->>'customerId'
          AND evidence->'scope'->>'livemode'=original->'scope'->>'livemode';
        IF NOT FOUND OR (retained->'event'->'data'->'object') IS DISTINCT FROM (contributor->'invoice')
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.observation->'trace'->'components') c
            WHERE c->>'invoiceId'=contributor->>'invoiceId'
              AND c->>'subscriptionId'=retained->'scope'->>'subscriptionId'
              AND c->>'providerSubscriptionId'=retained->'scope'->>'providerSubscriptionId'
              AND c->'period'=retained->'event'->'data'->'object'->'lines'->'data'->0->'period'
              AND (c->>'amount')::numeric=(retained->'event'->'data'->'object'->>'total')::numeric)
        THEN RAISE EXCEPTION 'debt contributor original mismatch'; END IF;
      END LOOP;
    END LOOP;
  END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;

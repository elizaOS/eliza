CREATE TABLE subscription_invoice_event_evidence (
  receipt_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  evidence jsonb NOT NULL,
  FOREIGN KEY(receipt_id,organization_id) REFERENCES billing_subscription_event_receipts(id,organization_id) ON DELETE RESTRICT,
  CHECK ((jsonb_typeof(evidence)='object' AND evidence->>'kind'='subscription_invoice_event_observation'
    AND evidence->>'version'='1' AND evidence->>'digest' ~ '^[a-f0-9]{64}$'
    AND evidence->'scope'->>'organizationId'=organization_id::text) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION guard_subscription_invoice_event_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE source billing_subscriptions%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'original invoice event evidence is immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id;
  IF NOT FOUND OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.provider_object_type<>'invoice' OR receipt.event_type<>'invoice.paid'
    OR (NEW.evidence->'scope'->>'subscriptionId') IS DISTINCT FROM receipt.subscription_id::text
    OR (NEW.evidence->'scope'->>'providerEventId') IS DISTINCT FROM receipt.provider_event_id
    OR (NEW.evidence->'scope'->>'invoiceId') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.evidence->'scope'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.evidence->'event'->>'created')::numeric IS DISTINCT FROM extract(epoch FROM receipt.event_created_at)
  THEN RAISE EXCEPTION 'original invoice event owner mismatch'; END IF;
  SELECT * INTO source FROM billing_subscriptions WHERE id=receipt.subscription_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR source.billing_scope_id IS NOT NULL
    OR (NEW.evidence->'scope'->>'customerId') IS DISTINCT FROM source.stripe_customer_id
    OR (NEW.evidence->'scope'->>'providerSubscriptionId') IS DISTINCT FROM source.stripe_subscription_id
    OR source.provider_environment IS DISTINCT FROM (CASE WHEN receipt.livemode THEN 'live' ELSE 'test' END)
  THEN RAISE EXCEPTION 'original invoice subscription owner mismatch'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_invoice_event_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_invoice_event_evidence
FOR EACH ROW EXECUTE FUNCTION guard_subscription_invoice_event_evidence();

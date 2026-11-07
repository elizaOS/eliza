-- Definitive original void outcomes preserve source authority and cannot be rewritten or dispatched again.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_failure_evidence jsonb;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_upgrade_failure_evidence_shape CHECK (
 organization_upgrade_failure_evidence IS NULL OR (kind='upgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='FAILED'
 AND error_code='ORIGINAL_UPGRADE_INVOICE_VOID' AND organization_upgrade_dispatch_state='started'
 AND organization_upgrade_failure_evidence->>'kind'='original_invoice_void'
 AND organization_upgrade_failure_evidence->>'invoiceId' ~ '^in_[A-Za-z0-9]+$'
 AND organization_upgrade_failure_evidence->>'invoiceDigest' ~ '^[a-f0-9]{64}$'
 AND organization_upgrade_failure_evidence->>'liveDigest' ~ '^[a-f0-9]{64}$'
 AND ((organization_upgrade_failure_evidence->'paymentIntentId'='null'::jsonb AND organization_upgrade_failure_evidence->'paymentIntentDigest'='null'::jsonb)
 OR (organization_upgrade_failure_evidence->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]+$' AND organization_upgrade_failure_evidence->>'paymentIntentDigest' ~ '^[a-f0-9]{64}$'))
 AND jsonb_typeof(organization_upgrade_failure_evidence->'livePeriodStart')='string'
 AND jsonb_typeof(organization_upgrade_failure_evidence->'livePeriodEnd')='string'
 AND jsonb_typeof(organization_upgrade_failure_evidence->'observedAt')='string') IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_void_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; source record; proof jsonb;
BEGIN
 IF NEW.app_id IS NOT NULL OR NEW.billing_scope_id IS NOT NULL OR NEW.kind<>'upgrade' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.organization_upgrade_failure_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original void upgrade result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'FAILED' OR NEW.organization_upgrade_dispatch_state IS DISTINCT FROM 'started' THEN RETURN NEW; END IF;
 proof=NEW.organization_upgrade_failure_evidence;
 IF proof IS NULL OR TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Original void failure requires a proven live observation' USING ERRCODE='23514'; END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR origin.invoice_id IS DISTINCT FROM proof->>'invoiceId' OR origin.provider_idempotency_key<>NEW.provider_idempotency_key THEN
  RAISE EXCEPTION 'Original void failure requires exact invoice attribution' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM organization_upgrade_historical_targets WHERE command_id=NEW.id AND organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Original void failure conflicts with applied target evidence' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.expected_subscription_revision OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR source.status<>'active' OR source.cancel_at_period_end OR source.pending_plan_key IS NOT NULL OR source.ended_at IS NOT NULL OR source.dunning_started_at IS NOT NULL OR source.grace_expires_at IS NOT NULL
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(origin.customer_id,origin.subscription_id)
 OR (source.provider_environment='live') IS DISTINCT FROM origin.livemode
 OR NOT EXISTS (SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS (SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision)
 OR (((proof->>'livePeriodStart')::timestamptz=source.current_period_start AND (proof->>'livePeriodEnd')::timestamptz=source.current_period_end)
 OR (proof->>'livePeriodStart')::timestamptz>=source.current_period_end) IS NOT TRUE
 OR ((proof->>'livePeriodStart')::timestamptz<=(proof->>'observedAt')::timestamptz AND (proof->>'observedAt')::timestamptz<(proof->>'livePeriodEnd')::timestamptz AND (proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Original void failure requires unchanged source and live compatible period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_void_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_void_result();

-- Organization upgrades require atomic original-invoice source and allowance publication.
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_cancellation_result_check;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_cancellation_result_check CHECK (app_id IS NOT NULL OR ((kind IN ('cancel','resume','upgrade') AND status = 'APPLIED' AND result_subscription_id IS NOT NULL AND subscription_id IS NOT NULL AND result_subscription_id = subscription_id AND result_subscription_revision IS NOT NULL AND result_subscription_revision > 0) OR ((kind NOT IN ('cancel','resume','upgrade') OR status <> 'APPLIED') AND result_subscription_revision IS NULL)));
--> statement-breakpoint
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_status_shape_check;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_status_shape_check CHECK ((status = 'PREPARED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'OUTCOME_UNKNOWN' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUCCEEDED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'APPLIED' AND (billing_scope_id IS NOT NULL OR kind IN ('checkout','cancel','resume','upgrade')) AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND (result_subscription_id IS NOT NULL OR kind = 'import') AND applied_at IS NOT NULL) OR (status = 'FAILED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUPERSEDED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL));
--> statement-breakpoint
CREATE FUNCTION guard_organization_upgrade_paid_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; quote record; previous record; result record; posting record; projection record; bucket record; delta numeric;
BEGIN
 IF NEW.app_id IS NOT NULL OR NEW.billing_scope_id IS NOT NULL OR NEW.kind<>'upgrade' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status='APPLIED' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Applied organization upgrade result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'APPLIED' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' OR OLD.status<>'OUTCOME_UNKNOWN' OR OLD.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.result_subscription_id IS DISTINCT FROM NEW.subscription_id OR NEW.result_subscription_revision IS DISTINCT FROM NEW.expected_subscription_revision+1
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Paid organization upgrade requires its original live execution' USING ERRCODE='23514';
 END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR origin.provider_idempotency_key<>NEW.provider_idempotency_key THEN RAISE EXCEPTION 'Paid upgrade lacks original invoice' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.provider_binding IS NULL OR quote.subscription_id<>NEW.subscription_id OR quote.subscription_revision<>NEW.expected_subscription_revision OR quote.target_plan_key<>NEW.target_plan_key THEN RAISE EXCEPTION 'Paid upgrade lacks original review' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid upgrade lacks original revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO result FROM billing_subscriptions WHERE id=NEW.result_subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR result.billing_scope_id IS NOT NULL OR result.merchant_key<>'platform' OR result.lifecycle_revision<>NEW.result_subscription_revision
 OR result.plan_key<>NEW.target_plan_key OR result.status<>'active' OR result.cancel_at_period_end OR result.pending_plan_key IS NOT NULL OR result.ended_at IS NOT NULL OR result.dunning_started_at IS NOT NULL OR result.grace_expires_at IS NOT NULL
 OR ROW(result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.provider_environment,result.current_period_start,result.current_period_end,result.catalog_version)
 IS DISTINCT FROM ROW(previous.stripe_customer_id,previous.stripe_subscription_id,previous.stripe_subscription_item_id,previous.provider_environment,previous.current_period_start,previous.current_period_end,previous.catalog_version)
 OR result.stripe_customer_id<>origin.customer_id OR result.stripe_subscription_id<>origin.subscription_id OR (result.provider_environment='live') IS DISTINCT FROM origin.livemode THEN
  RAISE EXCEPTION 'Paid upgrade target source is not atomically published' USING ERRCODE='23514';
 END IF;
 SELECT * INTO projection FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL;
 IF NOT FOUND OR projection.source_subscription_id IS DISTINCT FROM NEW.subscription_id OR projection.source_subscription_revision IS DISTINCT FROM NEW.result_subscription_revision THEN RAISE EXCEPTION 'Paid upgrade entitlement is not atomically published' USING ERRCODE='23514'; END IF;
 SELECT * INTO bucket FROM subscription_allowance_periods WHERE organization_id=NEW.organization_id AND subscription_id=NEW.subscription_id AND billing_scope_id IS NULL AND period_start=previous.current_period_start AND period_end=previous.current_period_end;
 IF NOT FOUND OR bucket.merchant_key<>'platform' OR bucket.grant_source<>'paid_invoice' OR bucket.provider_environment<>result.provider_environment OR (bucket.expires_at<=clock_timestamp() AND bucket.available_amount<>0) THEN
  RAISE EXCEPTION 'Paid upgrade requires its original paid period without expired spending revival' USING ERRCODE='23514';
 END IF;
 delta=(quote.review->>'additionalAllowanceUsd')::numeric;
 SELECT * INTO posting FROM subscription_allowance_transactions WHERE merchant_key='platform' AND source_invoice_id=origin.invoice_id;
 IF delta IS NULL OR delta<0 OR (delta=0 AND FOUND) OR (delta>0 AND (NOT FOUND OR posting.organization_id<>NEW.organization_id OR posting.allowance_period_id<>bucket.id OR bucket.adjustment_amount<delta OR posting.kind<>'grant_adjustment' OR posting.amount<>delta OR posting.source_subscription_id<>NEW.subscription_id OR posting.source_subscription_revision<>NEW.result_subscription_revision OR posting.source_plan_key<>NEW.target_plan_key OR posting.source_catalog_version<>quote.catalog_version)) THEN
  RAISE EXCEPTION 'Paid upgrade requires its exact once-only allowance adjustment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_upgrade_paid_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_paid_result();

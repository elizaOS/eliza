-- A proven original configuration publishes pending state, never an immediate paid-plan change.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_configuration_evidence jsonb;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_configuration_evidence_shape CHECK (
organization_schedule_configuration_evidence IS NULL OR (
 kind='downgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='APPLIED'
 AND jsonb_typeof(organization_schedule_configuration_evidence)='object'
 AND organization_schedule_configuration_evidence->>'kind'='original_schedule_configured'
 AND organization_schedule_configuration_evidence->>'targetPlanKey' IN ('plus_monthly','pro_monthly')
 AND jsonb_typeof(organization_schedule_configuration_evidence->'effectiveAt')='number'
 AND organization_schedule_configuration_evidence->>'effectiveAt' ~ '^[0-9]+$'
 AND organization_schedule_configuration_evidence->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$'
 AND organization_schedule_configuration_evidence ?& ARRAY['kind','effectiveAt','targetPlanKey','scheduleId','requestDigest','snapshotDigest','retainedTermsDigest','reviewDigest','providerBindingDigest','quoteId','sourceDigest','createEffectId','configurationEffectId','createReceiptDigest','configurationReceiptDigest','observedAt']
 AND organization_schedule_configuration_evidence-ARRAY['kind','effectiveAt','targetPlanKey','scheduleId','requestDigest','snapshotDigest','retainedTermsDigest','reviewDigest','providerBindingDigest','quoteId','sourceDigest','createEffectId','configurationEffectId','createReceiptDigest','configurationReceiptDigest','observedAt']='{}'::jsonb
 AND organization_schedule_configuration_evidence->>'requestDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'snapshotDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'retainedTermsDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'reviewDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'providerBindingDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'quoteId')='string'
 AND organization_schedule_configuration_evidence->>'sourceDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'createEffectId')='string'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'configurationEffectId')='string'
 AND organization_schedule_configuration_evidence->>'createReceiptDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'configurationReceiptDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'observedAt')='string'
) IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_schedule_configured_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb; created_effect record; configured_effect record; quote record; terms record; source record; previous record; result record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_schedule_configuration_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original configured schedule result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 proof=NEW.organization_schedule_configuration_evidence;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$'
 OR NEW.completed_at IS NULL OR NEW.completed_at>clock_timestamp() OR NEW.applied_at IS NULL OR NEW.applied_at>clock_timestamp()
 OR NEW.result_subscription_id IS DISTINCT FROM NEW.subscription_id
 OR NEW.result_subscription_revision IS DISTINCT FROM NEW.expected_subscription_revision+1
 OR ((proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Configured result requires live original lease and next revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO created_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_create';
 IF NOT FOUND OR created_effect.state<>'observed' OR created_effect.id::text IS DISTINCT FROM proof->>'createEffectId'
 OR created_effect.receipt_digest IS DISTINCT FROM proof->>'createReceiptDigest' OR created_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' THEN
  RAISE EXCEPTION 'Configured result requires original create receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO configured_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_configure';
 IF NOT FOUND OR configured_effect.state<>'observed' OR configured_effect.predecessor_id IS DISTINCT FROM created_effect.id
 OR configured_effect.id::text IS DISTINCT FROM proof->>'configurationEffectId' OR configured_effect.receipt_digest IS DISTINCT FROM proof->>'configurationReceiptDigest'
 OR configured_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' OR configured_effect.request_digest IS DISTINCT FROM proof->>'requestDigest'
 OR (proof->>'observedAt')::timestamptz<configured_effect.observed_at
 OR EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.id AND kind='schedule_release') THEN
  RAISE EXCEPTION 'Configured result requires original configuration and no compensation' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.id::text IS DISTINCT FROM proof->>'quoteId' OR quote.source_digest IS DISTINCT FROM proof->>'sourceDigest'
 OR quote.review_digest IS DISTINCT FROM proof->>'reviewDigest' OR quote.target_plan_key IS DISTINCT FROM proof->>'targetPlanKey'
 OR quote.target_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR configured_effect.started_at>=quote.expires_at OR configured_effect.started_at<(quote.review->>'observedAt')::timestamptz
 OR configured_effect.request_payload#>>'{params,phases,1,items,0,price}' IS DISTINCT FROM quote.provider_binding->>'targetPriceId'
 OR (proof->>'effectiveAt')::bigint IS DISTINCT FROM extract(epoch FROM (quote.review->>'effectiveAt')::timestamptz)::bigint THEN
  RAISE EXCEPTION 'Configured result requires exact original reviewed target' USING ERRCODE='23514'; END IF;
 SELECT * INTO terms FROM organization_schedule_quote_terms WHERE quote_id=quote.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR terms.snapshot_digest IS DISTINCT FROM proof->>'retainedTermsDigest' THEN
  RAISE EXCEPTION 'Configured result requires original retained settings' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND OR previous.pending_plan_key IS NOT NULL OR previous.status<>'active' OR previous.cancel_at_period_end OR previous.ended_at IS NOT NULL OR previous.dunning_started_at IS NOT NULL OR previous.grace_expires_at IS NOT NULL THEN
  RAISE EXCEPTION 'Configured result requires eligible original paid revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO result FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.result_subscription_revision;
 IF NOT FOUND OR result.pending_plan_key IS DISTINCT FROM NEW.target_plan_key OR result.source<>'reconciliation'
 OR result.provider_event_id IS NOT NULL OR result.provider_event_created_at IS NOT NULL
 OR result.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR (to_jsonb(previous)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at'])
    IS DISTINCT FROM (to_jsonb(result)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at']) THEN
  RAISE EXCEPTION 'Configured result must preserve all paid revision fields' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.result_subscription_revision OR source.pending_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform' OR source.plan_key IS DISTINCT FROM previous.plan_key
 OR source.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR clock_timestamp()>=source.current_period_end
 OR ROW(source.billing_scope_id,source.merchant_key,source.plan_revision_id,source.trial_start,source.trial_end,source.quantity,source.provider,source.provider_environment,source.stripe_customer_id,source.stripe_subscription_id,source.stripe_subscription_item_id,source.catalog_version,source.plan_key,source.status,source.current_period_start,source.current_period_end,source.cancel_at_period_end,source.canceled_at,source.ended_at,source.dunning_started_at,source.grace_expires_at,source.pending_plan_key,source.provider_object_digest) IS DISTINCT FROM ROW(result.billing_scope_id,result.merchant_key,result.plan_revision_id,result.trial_start,result.trial_end,result.quantity,result.provider,result.provider_environment,result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.catalog_version,result.plan_key,result.status,result.current_period_start,result.current_period_end,result.cancel_at_period_end,result.canceled_at,result.ended_at,result.dunning_started_at,result.grace_expires_at,result.pending_plan_key,result.provider_object_digest)
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start AND (proof->>'observedAt')::timestamptz<source.current_period_end) IS NOT TRUE
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id AND is_active AND account_lifecycle_state='active' AND paid_work_fenced_at IS NULL AND account_deletion_request_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision AND plan_key=previous.plan_key)
 OR EXISTS(SELECT 1 FROM subscription_allowance_transactions WHERE source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Configured result requires current projection without a new allowance posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_configured_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_configured_result();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_organization_schedule_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id) THEN RETURN NEW; END IF;
 IF ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.kind,NEW.target_plan_key,NEW.request_digest,NEW.provider_idempotency_key,NEW.app_id,NEW.billing_scope_id,NEW.merchant_key,NEW.provider_started_at)
  IS DISTINCT FROM ROW(OLD.organization_id,OLD.requested_by_user_id,OLD.subscription_id,OLD.expected_subscription_revision,OLD.kind,OLD.target_plan_key,OLD.request_digest,OLD.provider_idempotency_key,OLD.app_id,OLD.billing_scope_id,OLD.merchant_key,OLD.provider_started_at) THEN
  RAISE EXCEPTION 'Original schedule command authority cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED'
  AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND kind='schedule_create' AND state='ready')
  AND NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND (kind<>'schedule_create' OR state<>'ready'))
 ) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED' AND NEW.organization_schedule_failure_evidence IS NOT NULL) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='APPLIED' AND NEW.organization_schedule_configuration_evidence IS NOT NULL) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
 IF NEW.execution_generation IS DISTINCT FROM OLD.execution_generation OR (NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
  IF NEW.status<>'OUTCOME_UNKNOWN' OR NEW.execution_generation<>OLD.execution_generation+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'Schedule lease replacement requires an expired original generation' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>OLD.lease_expires_at THEN
  RAISE EXCEPTION 'Schedule lease cannot be extended or revived in place' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

--> statement-breakpoint
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_cancellation_result_check;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_cancellation_result_check CHECK (
(app_id IS NOT NULL OR ((kind IN ('cancel','resume','upgrade') AND status = 'APPLIED' AND result_subscription_id IS NOT NULL AND subscription_id IS NOT NULL AND result_subscription_id = subscription_id AND result_subscription_revision IS NOT NULL AND result_subscription_revision > 0) OR ((kind NOT IN ('cancel','resume','upgrade') OR status <> 'APPLIED') AND result_subscription_revision IS NULL))) OR (app_id IS NULL AND billing_scope_id IS NULL AND kind='downgrade' AND status='APPLIED' AND organization_schedule_configuration_evidence IS NOT NULL AND subscription_id IS NOT NULL AND result_subscription_id=subscription_id AND result_subscription_revision=expected_subscription_revision+1) IS TRUE
);

--> statement-breakpoint
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_status_shape_check;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_status_shape_check CHECK (
(status = 'PREPARED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'OUTCOME_UNKNOWN' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUCCEEDED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'APPLIED' AND (billing_scope_id IS NOT NULL OR kind IN ('checkout','cancel','resume','upgrade') OR (kind='downgrade' AND organization_schedule_configuration_evidence IS NOT NULL)) AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND (result_subscription_id IS NOT NULL OR kind = 'import') AND applied_at IS NOT NULL) OR (status = 'FAILED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUPERSEDED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL)
);

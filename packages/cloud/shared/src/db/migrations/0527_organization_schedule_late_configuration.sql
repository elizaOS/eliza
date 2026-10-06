-- Read-only recovery can record the original pending configuration after the paid boundary.
-- Provider evidence/live compatibility are verified by the service before publication.
-- Keep exact original dispatch, source/lease/organization fencing, expired entitlement
-- deadline and no new allowance posting; configuration never proves payment.
CREATE OR REPLACE FUNCTION guard_organization_schedule_configured_result() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR ROW(source.billing_scope_id,source.merchant_key,source.plan_revision_id,source.trial_start,source.trial_end,source.quantity,source.provider,source.provider_environment,source.stripe_customer_id,source.stripe_subscription_id,source.stripe_subscription_item_id,source.catalog_version,source.plan_key,source.status,source.current_period_start,source.current_period_end,source.cancel_at_period_end,source.canceled_at,source.ended_at,source.dunning_started_at,source.grace_expires_at,source.pending_plan_key,source.provider_object_digest) IS DISTINCT FROM ROW(result.billing_scope_id,result.merchant_key,result.plan_revision_id,result.trial_start,result.trial_end,result.quantity,result.provider,result.provider_environment,result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.catalog_version,result.plan_key,result.status,result.current_period_start,result.current_period_end,result.cancel_at_period_end,result.canceled_at,result.ended_at,result.dunning_started_at,result.grace_expires_at,result.pending_plan_key,result.provider_object_digest)
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start) IS NOT TRUE
 OR (configured_effect.started_at>=source.current_period_start AND configured_effect.started_at<source.current_period_end) IS NOT TRUE
 OR source.current_period_end IS DISTINCT FROM to_timestamp((proof->>'effectiveAt')::bigint)
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id AND is_active AND account_lifecycle_state='active' AND paid_work_fenced_at IS NULL AND account_deletion_request_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision AND plan_key=previous.plan_key AND effective_from=source.current_period_start AND effective_until=source.current_period_end)
 OR EXISTS(SELECT 1 FROM subscription_allowance_transactions WHERE source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Configured result requires current projection without a new allowance posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

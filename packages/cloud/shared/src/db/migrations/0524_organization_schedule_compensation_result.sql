-- A proven original partial-create release retires the downgrade without publishing a plan.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_failure_evidence jsonb;
--> statement-breakpoint
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_failure_evidence_shape CHECK (
 organization_schedule_failure_evidence IS NULL OR (
  kind='downgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform'
  AND status='FAILED' AND error_code='ORIGINAL_SCHEDULE_CREATE_COMPENSATED'
  AND jsonb_typeof(organization_schedule_failure_evidence)='object'
  AND organization_schedule_failure_evidence->>'kind'='original_unconfigured_schedule_released'
  AND organization_schedule_failure_evidence->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$'
  AND organization_schedule_failure_evidence->>'createReceiptDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'releaseReceiptDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'snapshotDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'retainedTermsDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'sourceDigest' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(organization_schedule_failure_evidence->'quoteId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'createEffectId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'releaseEffectId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'observedAt')='string'
  AND organization_schedule_failure_evidence-ARRAY['kind','scheduleId','createReceiptDigest','releaseReceiptDigest','snapshotDigest','retainedTermsDigest','sourceDigest','quoteId','createEffectId','releaseEffectId','observedAt']='{}'::jsonb
 ) IS TRUE
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_schedule_compensation_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb; created_effect record; released_effect record; quote record; terms record; source record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_schedule_failure_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original compensated schedule result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 proof=NEW.organization_schedule_failure_evidence;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'FAILED'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$'
 OR NEW.completed_at IS NULL OR NEW.completed_at>clock_timestamp()
 OR NEW.applied_at IS NOT NULL OR NEW.result_subscription_id IS NOT NULL OR NEW.result_subscription_revision IS NOT NULL
 OR ((proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Compensated schedule result requires a live original observation lease' USING ERRCODE='23514'; END IF;
 SELECT * INTO created_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_create';
 IF NOT FOUND OR created_effect.state<>'observed' OR created_effect.id::text IS DISTINCT FROM proof->>'createEffectId'
 OR created_effect.receipt_digest IS DISTINCT FROM proof->>'createReceiptDigest' OR created_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' THEN
  RAISE EXCEPTION 'Compensated result requires exact original created receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO released_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_release';
 IF NOT FOUND OR released_effect.state<>'observed' OR released_effect.predecessor_id IS DISTINCT FROM created_effect.id
 OR released_effect.id::text IS DISTINCT FROM proof->>'releaseEffectId' OR released_effect.receipt_digest IS DISTINCT FROM proof->>'releaseReceiptDigest'
 OR released_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId'
 OR (proof->>'observedAt')::timestamptz<released_effect.observed_at
 OR EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.id AND kind='schedule_configure' AND state<>'ready') THEN
  RAISE EXCEPTION 'Compensated result requires exact original unconfigured release' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.id::text IS DISTINCT FROM proof->>'quoteId' OR quote.source_digest IS DISTINCT FROM proof->>'sourceDigest' THEN
  RAISE EXCEPTION 'Compensated result requires its original quote' USING ERRCODE='23514'; END IF;
 SELECT * INTO terms FROM organization_schedule_quote_terms WHERE quote_id=quote.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR terms.snapshot_digest IS DISTINCT FROM proof->>'retainedTermsDigest' THEN
  RAISE EXCEPTION 'Compensated result requires original retained settings' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.expected_subscription_revision OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start AND (proof->>'observedAt')::timestamptz<source.current_period_end) IS NOT TRUE
 OR source.status<>'active' OR source.cancel_at_period_end OR source.pending_plan_key IS NOT NULL OR source.ended_at IS NOT NULL OR source.dunning_started_at IS NOT NULL OR source.grace_expires_at IS NOT NULL
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR (source.provider_environment='live') IS DISTINCT FROM created_effect.livemode
 OR (terms.snapshot->'subscription'->>'current_period_start')::bigint IS DISTINCT FROM extract(epoch FROM source.current_period_start)::bigint
 OR (terms.snapshot->'subscription'->>'current_period_end')::bigint IS DISTINCT FROM extract(epoch FROM source.current_period_end)::bigint
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Compensated result requires unchanged current source and projection' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_compensation_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_compensation_result();
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
 ) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED' AND NEW.organization_schedule_failure_evidence IS NOT NULL) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
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

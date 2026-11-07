-- Compensation retains an independent one-time release identity under the original lease.
-- Quote expiry cannot strand a proven unconfigured create; unknown configuration cannot be released.
ALTER TABLE organization_schedule_effects DROP CONSTRAINT organization_schedule_effects_kind_check;
ALTER TABLE organization_schedule_effects ADD CONSTRAINT organization_schedule_effects_kind_check CHECK(kind IN ('schedule_create','schedule_configure','schedule_release'));
ALTER TABLE organization_schedule_effects DROP CONSTRAINT organization_schedule_effect_identity;
ALTER TABLE organization_schedule_effects ADD CONSTRAINT organization_schedule_effect_identity CHECK ((customer_id ~ '^cus_[A-Za-z0-9]+$' AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND request_digest ~ '^[a-f0-9]{64}$' AND provider_idempotency_key='organization-schedule:'||command_id::text||':'||kind AND request_payload->>'kind'=kind AND jsonb_typeof(request_payload)='object' AND ((kind='schedule_create' AND predecessor_id IS NULL AND request_payload->>'subscriptionId'=subscription_id AND request_payload-ARRAY['kind','subscriptionId']='{}'::jsonb) OR (kind IN ('schedule_configure','schedule_release') AND predecessor_id IS NOT NULL AND request_payload->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND jsonb_typeof(request_payload->'params')='object' AND request_payload-ARRAY['kind','scheduleId','params']='{}'::jsonb AND (kind<>'schedule_release' OR request_payload->'params'='{"preserve_cancel_date":true}'::jsonb)))) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_organization_schedule_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; quote record; source record; predecessor record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Schedule effect audit cannot be deleted' USING ERRCODE='23514'; END IF;
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'downgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.merchant_key<>'platform' THEN
  RAISE EXCEPTION 'Schedule effect requires its original platform downgrade' USING ERRCODE='23514';
 END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.review->>'kind' IS DISTINCT FROM 'downgrade_estimate' OR ROW(quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key) IS DISTINCT FROM ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) THEN
  RAISE EXCEPTION 'Schedule effect requires its original consumed review' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source FROM billing_subscriptions WHERE id=command.subscription_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(NEW.customer_id,NEW.subscription_id) OR (source.provider_environment='live') IS DISTINCT FROM NEW.livemode OR source.lifecycle_revision<>command.expected_subscription_revision
   OR NEW.state<>'ready' OR command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR (NEW.kind<>'schedule_release' AND quote.expires_at<=clock_timestamp()) OR NEW.created_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Schedule effect must begin ready under live original source' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) THEN
   RAISE EXCEPTION 'Schedule effect request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='observed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Schedule effect receipt is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.state<>'ready' AND ROW(NEW.started_at,NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(OLD.started_at,OLD.started_generation,OLD.started_lease_token) THEN RAISE EXCEPTION 'Schedule effect dispatch cannot be reset' USING ERRCODE='23514'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='ready' AND NEW.state='started') OR (OLD.state='started' AND NEW.state='observed')) THEN RAISE EXCEPTION 'Schedule effect transition is invalid' USING ERRCODE='23514'; END IF;
  IF OLD.state='ready' AND NEW.state='started' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.started_at>clock_timestamp() OR (NEW.kind<>'schedule_release' AND quote.expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Schedule dispatch requires the current original lease and live review' USING ERRCODE='23514';
   END IF;
  END IF;
  IF OLD.state='started' AND NEW.state='observed' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.observation_generation,NEW.observation_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.observed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule observation requires the current original lease' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF NEW.kind IN ('schedule_configure','schedule_release') THEN
  SELECT * INTO predecessor FROM organization_schedule_effects WHERE id=NEW.predecessor_id AND command_id=NEW.command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR predecessor.kind<>'schedule_create' OR predecessor.state<>'observed' OR NEW.request_payload->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId' OR (NEW.receipt IS NOT NULL AND NEW.receipt->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId') THEN
   RAISE EXCEPTION 'Schedule configure requires its original observed create' USING ERRCODE='23514';
  END IF;
 END IF;

 IF NEW.kind='schedule_release' AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.command_id AND kind='schedule_configure' AND state<>'ready') THEN
  RAISE EXCEPTION 'Unknown or observed configuration cannot be compensated by release' USING ERRCODE='23514';
 END IF;
 IF NEW.kind='schedule_configure' AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.command_id AND kind='schedule_release') THEN
  RAISE EXCEPTION 'Configuration cannot race an original compensation release' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

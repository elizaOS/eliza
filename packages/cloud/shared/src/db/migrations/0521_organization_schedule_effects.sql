-- Sequential provider effects retain independent request/receipt identity under the original command lease.
CREATE TABLE organization_schedule_effects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 command_id uuid NOT NULL,
 predecessor_id uuid REFERENCES organization_schedule_effects(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK (kind IN ('schedule_create','schedule_configure')),
 provider_idempotency_key text NOT NULL CONSTRAINT organization_schedule_effect_provider_key UNIQUE,
 customer_id text NOT NULL,
 subscription_id text NOT NULL,
 livemode boolean NOT NULL,
 request_payload jsonb NOT NULL,
 request_digest text NOT NULL,
 state text NOT NULL DEFAULT 'ready',
 started_at timestamptz,
 started_generation bigint,
 started_lease_token uuid,
 receipt jsonb,
 receipt_digest text,
 observed_at timestamptz,
 observation_generation bigint,
 observation_lease_token uuid,
 created_at timestamptz NOT NULL,
 CONSTRAINT organization_schedule_effect_command_fk FOREIGN KEY(command_id,organization_id) REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_schedule_effect_command_kind UNIQUE(command_id,kind),
 CONSTRAINT organization_schedule_effect_identity CHECK ((customer_id ~ '^cus_[A-Za-z0-9]+$' AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND request_digest ~ '^[a-f0-9]{64}$' AND provider_idempotency_key='organization-schedule:'||command_id::text||':'||kind AND request_payload->>'kind'=kind AND jsonb_typeof(request_payload)='object' AND ((kind='schedule_create' AND predecessor_id IS NULL AND request_payload->>'subscriptionId'=subscription_id AND request_payload-ARRAY['kind','subscriptionId']='{}'::jsonb) OR (kind='schedule_configure' AND predecessor_id IS NOT NULL AND request_payload->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND jsonb_typeof(request_payload->'params')='object' AND request_payload-ARRAY['kind','scheduleId','params']='{}'::jsonb))) IS TRUE),
 CONSTRAINT organization_schedule_effect_state CHECK ((
 (state='ready' AND started_at IS NULL AND started_generation IS NULL AND started_lease_token IS NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL)
 OR (state='started' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL)
 OR (state='observed' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NOT NULL AND receipt_digest ~ '^[a-f0-9]{64}$' AND observed_at>=started_at AND observation_generation>=started_generation AND observation_lease_token IS NOT NULL)
 ) IS TRUE),
 CONSTRAINT organization_schedule_effect_receipt CHECK (receipt IS NULL OR (
  jsonb_typeof(receipt)='object' AND receipt-ARRAY['kind','scheduleId','customerId','subscriptionId','livemode','apiVersion','providerRequestId','providerIdempotencyKey','eventId','evidenceDigest','observedAt']='{}'::jsonb
  AND receipt->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND receipt->>'customerId'=customer_id AND receipt->>'subscriptionId'=subscription_id AND receipt->'livemode'=to_jsonb(livemode)
  AND receipt->>'apiVersion'='2024-11-20.acacia' AND receipt->>'providerRequestId' ~ '^req_[A-Za-z0-9]+$' AND receipt->>'providerIdempotencyKey'=provider_idempotency_key AND receipt->>'evidenceDigest' ~ '^[a-f0-9]{64}$'
  AND (receipt->>'observedAt')::timestamptz=observed_at
  AND ((receipt->>'kind'='response' AND receipt->'eventId'='null'::jsonb) OR (receipt->>'kind'='event' AND receipt->>'eventId' ~ '^evt_[A-Za-z0-9]+$'))
 ) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION guard_organization_schedule_effect() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR NEW.state<>'ready' OR command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR quote.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp() THEN
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
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.started_at>clock_timestamp() OR quote.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule dispatch requires the current original lease and live review' USING ERRCODE='23514';
   END IF;
  END IF;
  IF OLD.state='started' AND NEW.state='observed' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.observation_generation,NEW.observation_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.observed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule observation requires the current original lease' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF NEW.kind='schedule_configure' THEN
  SELECT * INTO predecessor FROM organization_schedule_effects WHERE id=NEW.predecessor_id AND command_id=NEW.command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR predecessor.kind<>'schedule_create' OR predecessor.state<>'observed' OR NEW.request_payload->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId' OR (NEW.receipt IS NOT NULL AND NEW.receipt->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId') THEN
   RAISE EXCEPTION 'Schedule configure requires its original observed create' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organization_schedule_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_schedule_effects FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_effect();
--> statement-breakpoint
-- Other command writers must not erase uncertainty or revive a stale scheduling lease.
CREATE FUNCTION guard_organization_schedule_command() RETURNS trigger LANGUAGE plpgsql AS $$
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
 ) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
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
CREATE TRIGGER organization_schedule_command_guard BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_command();

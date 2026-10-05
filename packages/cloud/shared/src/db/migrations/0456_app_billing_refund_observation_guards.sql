CREATE OR REPLACE FUNCTION guard_app_billing_refund_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE; o jsonb; v jsonb; expected jsonb; result jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Refund observations are immutable'; END IF;
  PERFORM require_app_billing_refund_recovery(NEW.command_id,NEW.request_id,NEW.request_digest,NEW.lifecycle_revision,NEW.phase_receipt_id,NEW.phase_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=NEW.command_id;
  o:=NEW.observation; v:=o->'value';
  expected:=jsonb_build_object('operation','retrieveRefund','scope',c.request_payload->'source'->'scope','input',(c.request_payload->'source'->'invoice')||jsonb_build_object('refundId',v->>'refundId'));
  result:=jsonb_build_object('kind','refund','refundId',v->>'refundId','chargeId',v->>'chargeId','amountCents',v->'amountCents','currency',v->>'currency');
  IF NOT COALESCE(c.status IN('OUTCOME_UNKNOWN','SUCCEEDED') AND c.provider_started_at IS NOT NULL
    AND c.state_revision=NEW.command_revision AND c.execution_generation=NEW.execution_generation
    AND (c.lease_expires_at IS NULL OR (isfinite(c.lease_expires_at) AND c.lease_expires_at<=clock_timestamp()))
    AND o->>'merchantId'=c.merchant_id::text AND o->>'providerAccountId'=c.request_payload->'source'->'merchant'->>'stripeAccountId'
    AND o->'livemode'=to_jsonb(c.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND o->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(expected),'UTF8')),'hex')
    AND isfinite((o->>'observedAt')::timestamptz) AND (o->>'observedAt')::timestamptz>=c.provider_started_at AND (o->>'observedAt')::timestamptz<=clock_timestamp()
    AND v->>'refundId' ~ '^re_[A-Za-z0-9]+$' AND v->>'chargeId' ~ '^ch_[A-Za-z0-9]+$'
    AND jsonb_typeof(v->'amountCents')='number' AND (v->>'amountCents')::bigint=(c.request_payload->>'amountCents')::bigint
    AND v->>'currency'=c.request_payload->'source'->'invoice'->'plan'->>'currency'
    AND v ? 'status' AND (v->'status'='null'::jsonb OR v->>'status' IN('pending','requires_action','succeeded','failed','canceled'))
    AND (c.status<>'SUCCEEDED' OR (c.provider_result=result AND NEW.discovery IS NULL))
    AND (c.status<>'OUTCOME_UNKNOWN' OR (NEW.discovery->'value'=jsonb_build_object('status','found','object',v)
      AND NEW.discovery->>'inputDigest'=c.request_digest AND NEW.discovery->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(NEW.discovery->'value'),'UTF8')),'hex')
      AND NEW.discovery->>'merchantId'=o->>'merchantId' AND NEW.discovery->>'providerAccountId'=o->>'providerAccountId' AND NEW.discovery->'livemode'=o->'livemode'
      AND NEW.discovery->>'apiVersion'=o->>'apiVersion' AND isfinite((NEW.discovery->>'observedAt')::timestamptz)
      AND (NEW.discovery->>'observedAt')::timestamptz>=c.provider_started_at AND (NEW.discovery->>'observedAt')::timestamptz<=(o->>'observedAt')::timestamptz)),false)
    THEN RAISE EXCEPTION 'Refund observation does not match original command and provider evidence'; END IF;
  NEW.created_at:=clock_timestamp();
  NEW.observation_sequence:=nextval(pg_get_serial_sequence('app_billing_refund_observations','observation_sequence'));
  IF c.status='OUTCOME_UNKNOWN' THEN
    UPDATE billing_subscription_commands SET status='SUCCEEDED',provider_result=result,provider_response_digest=o->>'digest',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER app_billing_refund_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_refund_observations FOR EACH ROW EXECUTE FUNCTION guard_app_billing_refund_observation();
--> statement-breakpoint
CREATE TRIGGER app_billing_refund_observation_truncate_guard BEFORE TRUNCATE ON app_billing_refund_observations FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_refund_observation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION supersede_app_billing_refund_for_deletion(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_refund_recovery(p_command,p_request,p_digest,p_revision,p_phase,p_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  IF NOT COALESCE(c.status='PREPARED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL,false)
    THEN RAISE EXCEPTION 'Only never-dispatched refunds may be superseded'; END IF;
  UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='APP_BILLING_ACCOUNT_DELETION_SUPERSEDED',completed_at=clock_timestamp(),state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
END $$;

CREATE OR REPLACE FUNCTION validate_app_billing_customer_deletion_transition(command billing_subscription_commands, previous billing_subscription_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb := command.request_payload; result jsonb := command.provider_result; observation jsonb; authority jsonb;
BEGIN
  IF previous.id IS NULL THEN
    IF command.status IS DISTINCT FROM 'PREPARED' OR result IS NOT NULL THEN
      RAISE EXCEPTION 'Customer deletion must start with prepared durable intent';
    END IF;
    PERFORM require_app_billing_customer_terminal_obligations((payload->>'customerBindingId')::uuid,(payload->>'requestId')::uuid,payload->>'requestDigest',(payload->>'lifecycleRevision')::bigint,(payload->>'phaseReceiptId')::uuid,(payload->>'initiatingPhaseGeneration')::bigint);
    RETURN;
  END IF;
  IF previous.status='SUCCEEDED' THEN
    IF command IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Customer deletion completion is immutable'; END IF;
    RETURN;
  END IF;
  IF command.status NOT IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED') THEN
    RAISE EXCEPTION 'Customer deletion remains pending until exact tombstone proof';
  END IF;
  IF command.status<>'SUCCEEDED' THEN
    IF result IS NOT NULL THEN RAISE EXCEPTION 'Customer deletion result requires terminal proof'; END IF;
    RETURN;
  END IF;
  observation := result->'observation'; authority := result->'completionAuthority';
  IF NOT COALESCE(previous.status='OUTCOME_UNKNOWN' AND result->>'kind'='deleted_customer'
    AND result->>'customerBindingId'=payload->>'customerBindingId'
    AND observation->'value'->>'status'='deleted' AND observation->'value'->>'customerId'=payload->>'customerId'
    AND observation->>'merchantId'=command.merchant_id::text
    AND observation->>'providerAccountId'=payload->>'providerAccountId'
    AND (observation->>'livemode')::boolean=command.livemode
    AND observation->>'apiVersion'='2024-11-20.acacia'
    AND observation->>'digest'=command.provider_response_digest
    AND observation->>'inputDigest' ~ '^[0-9a-f]{64}$'
    AND isfinite((observation->>'observedAt')::timestamptz)
    AND (observation->>'observedAt')::timestamptz>=previous.provider_started_at
    AND (observation->>'observedAt')::timestamptz<=clock_timestamp()
    AND command.lease_token IS NULL AND command.lease_expires_at IS NULL
    AND command.execution_generation=previous.execution_generation,false)
  THEN RAISE EXCEPTION 'Customer deletion requires exact retained tombstone evidence'; END IF;
  PERFORM require_app_billing_customer_terminal_obligations((payload->>'customerBindingId')::uuid,(authority->>'requestId')::uuid,authority->>'requestDigest',(authority->>'lifecycleRevision')::bigint,(authority->>'phaseReceiptId')::uuid,(authority->>'phaseGeneration')::bigint,previous.id,previous.lease_token,previous.execution_generation,previous.state_revision);
END $$;

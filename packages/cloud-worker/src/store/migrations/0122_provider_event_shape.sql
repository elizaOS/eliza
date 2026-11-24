DO $$
DECLARE
  state_type regtype;
  historical_owner jsonb := '{"agentId":"cloud","actorId":"providerEvents","connector":"payment_provider"}';
  stored_owner jsonb := '{"agentId":"cloud","actorId":"payment-provider","connector":"provider-events"}';
BEGIN
  LOCK TABLE provider_events IN ACCESS EXCLUSIVE MODE;
  SELECT atttypid::regtype INTO state_type
  FROM pg_attribute
  WHERE attrelid = 'provider_events'::regclass AND attname = 'state' AND NOT attisdropped;

  IF state_type = 'text'::regtype AND EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid = 'provider_events'::regclass
      AND attname = 'claim' AND atttypid = 'jsonb'::regtype AND NOT attisdropped
  ) THEN
    PERFORM id, claim, revivals FROM provider_events WHERE false;
    RETURN;
  END IF;

  IF state_type IS DISTINCT FROM 'jsonb'::regtype THEN
    RAISE EXCEPTION 'Unrecognized provider event storage shape';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM provider_events AS event
    CROSS JOIN LATERAL (SELECT event.state->'lease' AS lease) AS receipt
    WHERE (
      event.state->'eventId' = to_jsonb(event.key)
      AND event.state->'payloadDigest' = to_jsonb(event.payload_digest)
      AND event.state->'phase'->>'tag' = event.phase
      AND event.state->'attempts' = to_jsonb(event.attempts)
      AND jsonb_typeof(event.state->'revivals') = 'number'
      AND (event.state->>'revivals')::integer >= 0
      AND jsonb_typeof(event.state->'dueAt') = 'number'
      AND event.next_attempt_at = greatest(
        (event.state->>'dueAt')::bigint,
        CASE WHEN lease->>'phase' = 'Claimed' THEN (lease->>'leaseUntil')::bigint ELSE 0 END
      )
      AND lease->'owner' = historical_owner
      AND lease->'rowPresent' = 'true'::jsonb
      AND lease->'authorized' = 'true'::jsonb
      AND jsonb_typeof(lease->'outcomeKnown') = 'boolean'
      AND jsonb_typeof(lease->'executorAlive') = 'boolean'
      AND jsonb_typeof(lease->'digest') = 'string'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(ARRAY[
          'claimSequence', 'currentClaim', 'invokedClaim', 'leaseUntil', 'expiresAt', 'now', 'effects'
        ]) AS field(name)
        WHERE jsonb_typeof(lease->field.name) IS DISTINCT FROM 'number'
           OR (lease->>field.name)::numeric NOT BETWEEN 0 AND 9007199254740991
           OR (lease->>field.name)::numeric <> trunc((lease->>field.name)::numeric)
      )
      AND CASE event.phase
        WHEN 'Done' THEN lease->>'phase' = 'Committed' AND event.payload IS NULL
        WHEN 'Leased' THEN lease->>'phase' = 'Claimed'
        WHEN 'DeadLettered' THEN lease->>'phase' = 'Claimed'
          AND event.state->'phase'->>'cause' = CASE WHEN event.last_error_code = 'ProviderEventMalformed'
            THEN 'PayloadUnreadable' ELSE 'AttemptsSpent' END
        WHEN 'Pending' THEN lease->>'phase' IN ('Pending', 'Claimed')
        ELSE false
      END
      AND (lease->>'phase' = 'Pending' OR lease->'digest' = to_jsonb(event.payload_digest))
      AND event.lease_until IS NOT DISTINCT FROM CASE
        WHEN event.phase = 'Leased' THEN (lease->>'leaseUntil')::bigint ELSE NULL END
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'Historical provider event receipts cannot be converted without changing their state';
  END IF;

  ALTER TABLE provider_events RENAME COLUMN key TO id;
  ALTER TABLE provider_events RENAME COLUMN state TO legacy_state;
  ALTER TABLE provider_events RENAME COLUMN phase TO state;
  ALTER TABLE provider_events ADD COLUMN claim jsonb;
  UPDATE provider_events SET
    claim = jsonb_set(legacy_state->'lease', '{owner}', stored_owner, false),
    revivals = (legacy_state->>'revivals')::integer;
  ALTER TABLE provider_events
    ALTER COLUMN claim SET NOT NULL,
    ALTER COLUMN attempts SET DEFAULT 0,
    DROP COLUMN legacy_state,
    DROP COLUMN revision;
END
$$;

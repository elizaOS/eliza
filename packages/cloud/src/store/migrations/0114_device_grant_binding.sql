ALTER TABLE accounts ADD COLUMN device_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE device_grants ADD COLUMN device_epoch bigint NOT NULL DEFAULT 0;

UPDATE device_grants AS g
SET device_epoch = CASE WHEN g.issued_at < COALESCE(a.devices_revoked_before, 0) THEN -1 ELSE 0 END
FROM accounts AS a
WHERE a.key = g.user_id;

WITH witnessed AS (
  SELECT key, phase, credential_id,
    CASE WHEN jsonb_typeof(state->'clientId') = 'string'
      AND length(state->>'clientId') > 0
      AND state->>'clientId' = client_id
      AND state->>'environment' IN ('Production', 'Staging')
      AND jsonb_typeof(state->'signInReturn'->'origin') = 'string'
      AND jsonb_typeof(state->'signInReturn'->'path') = 'string'
      AND length(state->'signInReturn'->>'origin') > 0
      AND length(state->'signInReturn'->>'path') > 0
    THEN jsonb_build_object('clientId', state->'clientId', 'environment', state->'environment',
      'signInReturn', jsonb_build_object('origin', state->'signInReturn'->'origin', 'path', state->'signInReturn'->'path')) END AS flat,
    CASE WHEN state->'client'->>'tag' = 'BoundClient'
      AND jsonb_typeof(state->'client'->'clientId') = 'string'
      AND length(state->'client'->>'clientId') > 0
      AND state->'client'->>'clientId' = client_id
      AND state->'client'->>'environment' IN ('Production', 'Staging')
      AND jsonb_typeof(state->'client'->'signInReturn'->'origin') = 'string'
      AND jsonb_typeof(state->'client'->'signInReturn'->'path') = 'string'
      AND length(state->'client'->'signInReturn'->>'origin') > 0
      AND length(state->'client'->'signInReturn'->>'path') > 0
    THEN jsonb_build_object('clientId', state->'client'->'clientId', 'environment', state->'client'->'environment',
      'signInReturn', jsonb_build_object('origin', state->'client'->'signInReturn'->'origin', 'path', state->'client'->'signInReturn'->'path')) END AS nested,
    CASE WHEN jsonb_typeof(state->'credentialTtl') = 'number' THEN (state->>'credentialTtl')::numeric END AS ttl
  FROM device_grants
), observed AS (
  SELECT key, COALESCE(COALESCE(flat, nested) IS NOT NULL
    AND (flat IS NULL OR nested IS NULL OR flat = nested)
    AND ttl = trunc(ttl) AND ttl BETWEEN 86400000 AND 7776000000
    AND (phase != 'exchanged' OR length(COALESCE(credential_id, '')) > 0), false) AS can_continue
  FROM witnessed
)
UPDATE device_grants AS g
SET state = jsonb_build_object('legacyDeviceGrant', jsonb_build_object(
    'state', g.state,
    'phase', g.phase,
    'clientId', g.client_id,
    'credentialId', COALESCE(g.credential_id, ''),
    'codeExpiresAt', g.code_expires_at,
    'keyExpiresAt', g.key_expires_at,
    'epoch', g.device_epoch,
    'observedAt', g.updated_at)),
  phase = CASE WHEN g.phase IN ('code_issued', 'exchanged') AND NOT observed.can_continue THEN 'ended' ELSE g.phase END,
  sealed_copy = CASE WHEN g.phase IN ('code_issued', 'exchanged') AND NOT observed.can_continue THEN NULL ELSE g.sealed_copy END
FROM observed
WHERE observed.key = g.key;

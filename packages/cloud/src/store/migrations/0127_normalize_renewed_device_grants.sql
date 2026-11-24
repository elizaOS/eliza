UPDATE device_grants
SET state = jsonb_set(state, '{origin,fromKey}', to_jsonb(renewed_from))
WHERE state->'origin' = '{"tag":"Renewed"}'::jsonb
  AND renewed_from IS NOT NULL;

UPDATE device_grants
SET state = jsonb_set(
  state,
  '{origin}',
  jsonb_build_object('tag', 'LegacyRenewed', 'fromKey', renewed_from)
)
WHERE state->'origin'->>'tag' = 'Renewed'
  AND sign_in_at IS NOT NULL
  AND renewed_from IS NOT NULL;

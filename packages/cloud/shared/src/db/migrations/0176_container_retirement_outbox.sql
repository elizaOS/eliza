-- Repair pre-atomic-retirement rows by giving every unowned `deleting`
-- container a pending delete job and recording that ownership in the same
-- statement. Re-running is a no-op because the live job excludes its row.
WITH orphaned AS (
  SELECT c.id, c.organization_id, c.metadata
  FROM containers c
  WHERE c.status = 'deleting'
    AND NOT EXISTS (
      SELECT 1
      FROM jobs j
      WHERE j.type = 'container_delete'
        AND j.organization_id = c.organization_id
        AND j.status IN ('pending', 'in_progress')
        AND j.data->>'containerId' = c.id::text
    )
  FOR UPDATE
), inserted AS (
  INSERT INTO jobs (id, type, status, data, data_storage, organization_id)
  SELECT
    gen_random_uuid(),
    'container_delete',
    'pending',
    jsonb_build_object(
      'containerId', orphaned.id::text,
      'organizationId', orphaned.organization_id::text
    ),
    'inline',
    orphaned.organization_id
  FROM orphaned
  RETURNING id, organization_id, data
)
UPDATE containers c
SET
  metadata = jsonb_set(
    coalesce(c.metadata, '{}'::jsonb),
    '{retirement}',
    jsonb_build_object(
      'deleteJobId', inserted.id::text,
      'retiredAt', now()::text,
      'recoveredBy', '0176_container_retirement_outbox'
    ),
    true
  ),
  updated_at = now()
FROM inserted
WHERE c.id = (inserted.data->>'containerId')::uuid
  AND c.organization_id = inserted.organization_id;

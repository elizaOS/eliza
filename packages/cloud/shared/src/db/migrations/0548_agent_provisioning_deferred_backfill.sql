-- Rows created with `autoProvision: false` before the deferred marker existed
-- are pending with no provision job on purpose. Mark pending eager-tier rows
-- that have no live provision job, so the orphaned-pending sweep cannot fail
-- one. A real orphan marked here stays recoverable: the dashboard shows it as
-- pending with Start, which calls `/provision` and enqueues the job.
UPDATE agent_sandboxes AS s
SET agent_config = COALESCE(s.agent_config, '{}'::jsonb) || '{"__agentProvisioningDeferred": true}'::jsonb
WHERE s.status = 'pending'
  AND s.pool_status IS NULL
  AND s.execution_tier IN ('dedicated-always', 'custom')
  AND NOT EXISTS (
    SELECT 1 FROM jobs AS j
    WHERE j.agent_id = s.id::text
      AND j.organization_id = s.organization_id
      AND j.type = 'agent_provision'
      AND (
        j.status IN ('pending', 'in_progress')
        OR (j.execution_generation IS NOT NULL AND j.execution_quiesced_at IS NULL)
      )
  );

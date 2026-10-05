-- Serialize the cutover with lifecycle and funding writers. Historical segments
-- remain immutable; corrected rates apply only from this migration onward.
LOCK TABLE agent_sandboxes, agent_compute_funding IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  next_state := CASE
    WHEN NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN NEW.status = 'running' THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  -- Funded Dedicated starts accept a durable tariff before provisioning. Backup
  -- metadata updates must not replace that tariff with the legacy default.
  next_rate := CASE next_state WHEN 'running' THEN COALESCE((
    SELECT funding.hourly_rate FROM agent_compute_funding funding
    WHERE funding.organization_id = NEW.organization_id
      AND funding.agent_id = NEW.id AND funding.settled_at IS NULL
  ), 0.010000) WHEN 'backup' THEN 0.002500 ELSE 0.000000 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at, NEW.pool_status)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at, OLD.pool_status) THEN
    -- The workload row lock serializes these trigger calls. Advance beyond its
    -- durable cursor so equal clock readings cannot let a random UUID reorder state.
    next_effective_at := clock_timestamp();
    SELECT GREATEST(
      next_effective_at,
      COALESCE(MAX(segment.effective_at) + interval '1 microsecond', next_effective_at)
    ) INTO next_effective_at
    FROM compute_billing_rate_segments segment
    WHERE segment.organization_id = NEW.organization_id
      AND segment.workload_kind = 'agent'
      AND segment.workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
      next_state, next_rate, next_effective_at);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_compute_billing_rate_segment_append ON agent_sandboxes;

CREATE TRIGGER agent_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at, pool_status
  ON agent_sandboxes FOR EACH ROW
  EXECUTE FUNCTION append_agent_compute_billing_rate_segment();

--> statement-breakpoint
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at)
SELECT sandbox.organization_id, 'agent', sandbox.id, sandbox.lifecycle_revision,
       'running', funding.hourly_rate,
       GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond')
FROM agent_sandboxes sandbox
JOIN agent_compute_funding funding
  ON funding.agent_id = sandbox.id
  AND funding.organization_id = sandbox.organization_id
  AND funding.settled_at IS NULL AND funding.host_lease_confirmed_at IS NOT NULL
JOIN LATERAL (
  SELECT segment.billing_state, segment.rate_per_hour, segment.effective_at
  FROM compute_billing_rate_segments segment
  WHERE segment.organization_id = sandbox.organization_id
    AND segment.workload_kind = 'agent' AND segment.workload_id = sandbox.id
  ORDER BY segment.effective_at DESC, segment.id DESC LIMIT 1
) latest ON true
WHERE sandbox.status = 'running' AND sandbox.pool_status IS NULL
  AND sandbox.execution_tier IS DISTINCT FROM 'shared'
  AND latest.billing_state = 'running'
  AND latest.rate_per_hour IS DISTINCT FROM funding.hourly_rate;

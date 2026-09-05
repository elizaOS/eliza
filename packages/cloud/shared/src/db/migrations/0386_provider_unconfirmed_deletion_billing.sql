-- Provider-backed compute remains billable while deletion is only requested,
-- pending, failed, or timed out. Provider-confirmed terminal states stay zero.

CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  next_state := CASE
    WHEN NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN NEW.status IN ('deletion_pending', 'deletion_failed')
      AND NEW.deletion_previous_status = 'stopped' THEN
      CASE WHEN NEW.last_backup_at IS NOT NULL THEN 'backup' ELSE 'not_billable' END
    WHEN NEW.status IN ('running', 'deletion_pending', 'deletion_failed') THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  next_rate := CASE next_state WHEN 'running' THEN 0.010000
    WHEN 'backup' THEN 0.002500 ELSE 0.000000 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at, NEW.pool_status, NEW.deletion_previous_status)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at, OLD.pool_status, OLD.deletion_previous_status) THEN
    SELECT GREATEST(clock_timestamp(),
      COALESCE(MAX(effective_at) + interval '1 microsecond', clock_timestamp()))
      INTO next_effective_at FROM compute_billing_rate_segments
      WHERE organization_id = NEW.organization_id AND workload_kind = 'agent'
        AND workload_id = NEW.id;
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
  AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at, pool_status, deletion_previous_status
  ON agent_sandboxes FOR EACH ROW
  EXECUTE FUNCTION append_agent_compute_billing_rate_segment();

CREATE OR REPLACE FUNCTION append_container_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_daily_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  next_state := CASE WHEN NEW.status IN ('running', 'deleting')
    THEN 'running' ELSE 'not_billable' END;
  next_daily_rate := CASE WHEN next_state = 'running' THEN ROUND((
    0.67::numeric * GREATEST(NEW.desired_count, 1)
    * CASE WHEN NEW.cpu > 1024 THEN NEW.cpu::numeric / 1024 ELSE 1 END
    * CASE WHEN NEW.memory > 2048 THEN sqrt(NEW.memory::numeric / 2048) ELSE 1 END
  ), 2) ELSE 0 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.desired_count, NEW.cpu, NEW.memory)
      IS DISTINCT FROM ROW(OLD.status, OLD.desired_count, OLD.cpu, OLD.memory) THEN
    SELECT GREATEST(clock_timestamp(),
      COALESCE(MAX(effective_at) + interval '1 microsecond', clock_timestamp()))
      INTO next_effective_at FROM compute_billing_rate_segments
      WHERE organization_id = NEW.organization_id AND workload_kind = 'container'
        AND workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES (NEW.organization_id, 'container', NEW.id, NEW.lifecycle_revision,
      next_state, next_daily_rate / 24, next_effective_at);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS container_compute_billing_rate_segment_append ON containers;
CREATE TRIGGER container_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, desired_count, cpu, memory
  ON containers FOR EACH ROW
  EXECUTE FUNCTION append_container_compute_billing_rate_segment();

INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at)
SELECT workload.organization_id, workload.kind, workload.id, workload.lifecycle_revision,
  workload.billing_state, workload.rate_per_hour,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond')
FROM (
  SELECT organization_id, 'agent'::text AS kind, id, lifecycle_revision,
    CASE WHEN deletion_previous_status = 'stopped'
      THEN CASE WHEN last_backup_at IS NOT NULL THEN 'backup' ELSE 'not_billable' END
      ELSE 'running' END AS billing_state,
    CASE WHEN deletion_previous_status = 'stopped'
      THEN CASE WHEN last_backup_at IS NOT NULL THEN 0.002500 ELSE 0.000000 END
      ELSE 0.010000 END::numeric AS rate_per_hour
  FROM agent_sandboxes
  WHERE status IN ('deletion_pending', 'deletion_failed')
    AND pool_status IS NULL AND execution_tier <> 'shared' AND deleted_at IS NULL
  UNION ALL
  SELECT organization_id, 'container', id, lifecycle_revision, 'running',
    ROUND((0.67::numeric * GREATEST(desired_count, 1)
      * CASE WHEN cpu > 1024 THEN cpu::numeric / 1024 ELSE 1 END
      * CASE WHEN memory > 2048 THEN sqrt(memory::numeric / 2048) ELSE 1 END), 2) / 24
  FROM containers WHERE status = 'deleting'
) workload
JOIN LATERAL (
  SELECT billing_state, rate_per_hour, effective_at
  FROM compute_billing_rate_segments segment
  WHERE segment.organization_id = workload.organization_id
    AND segment.workload_kind = workload.kind AND segment.workload_id = workload.id
  ORDER BY effective_at DESC, id DESC LIMIT 1
) latest ON true
WHERE latest.billing_state IS DISTINCT FROM workload.billing_state
  OR latest.rate_per_hour IS DISTINCT FROM workload.rate_per_hour;

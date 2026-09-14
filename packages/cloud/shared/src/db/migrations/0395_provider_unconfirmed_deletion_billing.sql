-- Reject unavailable historical authority before changing schema, functions or rows.
DO $$
DECLARE unresolved text;
BEGIN
WITH history AS (
  SELECT c.id, c.organization_id, c.lifecycle_revision,
    latest.id AS latest_id, latest.billing_state, latest.rate_per_hour,
    to_jsonb(latest)->>'lifecycle_status' AS lifecycle_status,
    previous.billing_state AS previous_state,
    previous.rate_per_hour AS previous_rate,
    latest.lifecycle_revision AS latest_revision,
    previous.lifecycle_revision AS previous_revision,
    EXISTS (
      SELECT 1 FROM container_compute_stop_intents proof
      JOIN compute_billing_rate_segments fence
        ON fence.organization_id = proof.organization_id
       AND fence.workload_kind = 'container' AND fence.workload_id = proof.container_id
       AND fence.lifecycle_revision = proof.lifecycle_revision
       AND fence.effective_at = proof.provider_confirmed_at
       AND fence.billing_state = 'not_billable' AND fence.rate_per_hour = 0
      WHERE proof.organization_id = c.organization_id AND proof.container_id = c.id
        AND proof.provider_confirmed_at IS NOT NULL
        AND c.lifecycle_revision BETWEEN proof.lifecycle_revision AND proof.lifecycle_revision + 2
        AND NOT EXISTS (
          SELECT 1 FROM compute_billing_rate_segments later
          WHERE later.organization_id = c.organization_id AND later.workload_kind = 'container'
            AND later.workload_id = c.id AND later.effective_at > fence.effective_at
            AND later.rate_per_hour > 0
        )
    ) AS stopped_proof
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id ORDER BY effective_at DESC, id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id AND (r.effective_at, r.id) < (latest.effective_at, latest.id)
    ORDER BY effective_at DESC, id DESC LIMIT 1
  ) previous ON true
  WHERE c.status = 'deleting'
), recovery AS (
  SELECT *, CASE
    WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN billing_state
    WHEN billing_state = 'not_billable' AND previous_state = 'running'
      AND latest_revision = previous_revision + 1 THEN 'running'
    ELSE NULL END AS recovered_state,
    CASE WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN rate_per_hour
      WHEN billing_state = 'not_billable' AND previous_state = 'running'
        AND latest_revision = previous_revision + 1 THEN previous_rate
      ELSE NULL END AS recovered_rate
  FROM history
)
  SELECT string_agg(id::text, ',' ORDER BY id) INTO unresolved
  FROM recovery WHERE recovered_state IS NULL;
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CONTAINER_DELETION_BILLING_HISTORY_UNRESOLVED',
      DETAIL = unresolved,
      HINT = 'Reconcile each owned workload through provider-confirmed stop recovery or restore its verified lifecycle history; do not infer a charge from deleting status.';
  END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO unresolved FROM agent_sandboxes a
  WHERE status IN ('deletion_pending', 'deletion_failed') AND billing_status = 'suspended'
    AND pool_status IS NULL AND execution_tier <> 'shared' AND deleted_at IS NULL
    AND (deletion_previous_billing_status IS NULL OR deletion_previous_status IS NULL)
    AND (deletion_previous_status = 'stopped' AND last_backup_at IS NULL) IS NOT TRUE
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  );
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'AGENT_DELETION_BILLING_PROVENANCE_UNRESOLVED',
      DETAIL = unresolved,
      HINT = 'Resolve missing pre-deletion billing authority against the owned lifecycle records before retrying; do not assume active billing.';
  END IF;
END $$;

ALTER TABLE compute_billing_rate_segments ADD COLUMN IF NOT EXISTS lifecycle_status text;

-- Provider-backed compute remains billable while deletion is only requested,
-- pending, failed, or timed out. Provider-confirmed terminal states stay zero.

CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
DECLARE deleting_update boolean;
DECLARE prior_state text;
DECLARE prior_rate numeric(16,6);
BEGIN
  deleting_update := TG_OP = 'UPDATE' AND NEW.status IN ('deletion_pending', 'deletion_failed')
    AND NEW.pool_status IS NULL AND NEW.execution_tier <> 'shared';
  IF deleting_update THEN
    SELECT billing_state, rate_per_hour INTO prior_state, prior_rate
      FROM compute_billing_rate_segments
      WHERE organization_id = OLD.organization_id AND workload_kind = 'agent'
        AND workload_id = OLD.id
      ORDER BY effective_at DESC, id DESC LIMIT 1;
    IF prior_state IS NULL OR prior_rate IS NULL THEN
      RAISE EXCEPTION 'AGENT_DELETION_BILLING_HISTORY_MISSING: %', OLD.id;
    END IF;
  END IF;
  next_state := CASE
    WHEN NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN deleting_update THEN prior_state
    WHEN NEW.status IN ('deletion_pending', 'deletion_failed')
      AND NEW.deletion_previous_status = 'stopped' THEN
      CASE WHEN NEW.last_backup_at IS NOT NULL THEN 'backup' ELSE 'not_billable' END
    WHEN NEW.status IN ('running', 'deletion_pending', 'deletion_failed') THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  next_rate := CASE WHEN deleting_update THEN prior_rate
    ELSE CASE next_state WHEN 'running' THEN COALESCE(
      (SELECT funding.hourly_rate FROM agent_compute_funding funding
       WHERE funding.organization_id = NEW.organization_id AND funding.agent_id = NEW.id
         AND funding.settled_at IS NULL), 0.010000)
      WHEN 'backup' THEN 0.002500 ELSE 0.000000 END END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at, NEW.pool_status, NEW.deletion_previous_status)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at, OLD.pool_status, OLD.deletion_previous_status) THEN
    SELECT GREATEST(clock_timestamp(),
      COALESCE(MAX(effective_at) + interval '1 microsecond', clock_timestamp()))
      INTO next_effective_at FROM compute_billing_rate_segments
      WHERE organization_id = NEW.organization_id AND workload_kind = 'agent'
        AND workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at, lifecycle_status)
    VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
      next_state, next_rate, next_effective_at, NEW.status);
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
DECLARE prior_state text;
DECLARE prior_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  IF NEW.status = 'deleting' AND TG_OP = 'UPDATE' THEN
    SELECT billing_state, rate_per_hour INTO prior_state, prior_rate
      FROM compute_billing_rate_segments
      WHERE organization_id = OLD.organization_id AND workload_kind = 'container'
        AND workload_id = OLD.id
      ORDER BY effective_at DESC, id DESC LIMIT 1;
    IF prior_state IS NULL THEN
      RAISE EXCEPTION 'CONTAINER_DELETION_BILLING_HISTORY_MISSING: %', OLD.id;
    END IF;
  END IF;
  next_state := CASE WHEN NEW.status = 'deleting' AND TG_OP = 'UPDATE' THEN prior_state
    WHEN NEW.status IN ('running', 'deleting') THEN 'running' ELSE 'not_billable' END;
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
       billing_state, rate_per_hour, effective_at, lifecycle_status)
    VALUES (NEW.organization_id, 'container', NEW.id, NEW.lifecycle_revision,
      next_state, CASE WHEN NEW.status = 'deleting' AND TG_OP = 'UPDATE'
        THEN prior_rate ELSE next_daily_rate / 24 END, next_effective_at, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS container_compute_billing_rate_segment_append ON containers;
CREATE TRIGGER container_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, desired_count, cpu, memory
  ON containers FOR EACH ROW
  EXECUTE FUNCTION append_container_compute_billing_rate_segment();

UPDATE agent_sandboxes a
SET billing_status = a.deletion_previous_billing_status,
    shutdown_warning_sent_at = a.deletion_previous_shutdown_warning_sent_at,
    scheduled_shutdown_at = a.deletion_previous_scheduled_shutdown_at
WHERE a.status IN ('deletion_pending', 'deletion_failed') AND a.billing_status = 'suspended'
  AND a.deletion_previous_billing_status IN ('active', 'warning', 'shutdown_pending')
  AND a.pool_status IS NULL AND a.execution_tier <> 'shared' AND a.deleted_at IS NULL
  AND (a.deletion_previous_status = 'running'
    OR (a.deletion_previous_status = 'stopped' AND a.last_backup_at IS NOT NULL))
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_stop_intents proof
    WHERE proof.organization_id = a.organization_id AND proof.agent_id = a.id
      AND proof.provider_confirmed_at >= a.deletion_started_at
      AND proof.lifecycle_revision <= a.lifecycle_revision
  );

INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT a.organization_id, 'agent', a.id, a.lifecycle_revision,
  CASE WHEN a.deletion_previous_status = 'stopped' THEN 'backup' ELSE 'running' END,
  CASE WHEN a.deletion_previous_status = 'stopped' THEN 0.002500 ELSE COALESCE(active_funding.hourly_rate, 0.010000) END,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), a.status
FROM agent_sandboxes a
JOIN LATERAL (
  SELECT billing_state, rate_per_hour, effective_at FROM compute_billing_rate_segments s
  WHERE s.organization_id = a.organization_id AND s.workload_kind = 'agent' AND s.workload_id = a.id
  ORDER BY effective_at DESC, id DESC LIMIT 1
) latest ON true
LEFT JOIN agent_compute_funding active_funding
  ON active_funding.organization_id = a.organization_id AND active_funding.agent_id = a.id
  AND active_funding.settled_at IS NULL
WHERE a.status IN ('deletion_pending', 'deletion_failed')
  AND a.pool_status IS NULL AND a.execution_tier <> 'shared' AND a.deleted_at IS NULL
  AND a.billing_status IN ('active', 'warning', 'shutdown_pending')
  AND (a.deletion_previous_status IS DISTINCT FROM 'stopped' OR a.last_backup_at IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  )
  AND (latest.billing_state IS DISTINCT FROM
    CASE WHEN a.deletion_previous_status = 'stopped' THEN 'backup' ELSE 'running' END
    OR latest.rate_per_hour IS DISTINCT FROM
    CASE WHEN a.deletion_previous_status = 'stopped' THEN 0.002500 ELSE COALESCE(active_funding.hourly_rate, 0.010000) END);

WITH history AS (
  SELECT c.id, c.organization_id, c.lifecycle_revision,
    latest.id AS latest_id, latest.billing_state, latest.rate_per_hour,
    to_jsonb(latest)->>'lifecycle_status' AS lifecycle_status,
    previous.billing_state AS previous_state,
    previous.rate_per_hour AS previous_rate,
    latest.lifecycle_revision AS latest_revision,
    previous.lifecycle_revision AS previous_revision,
    EXISTS (
      SELECT 1 FROM container_compute_stop_intents proof
      JOIN compute_billing_rate_segments fence
        ON fence.organization_id = proof.organization_id
       AND fence.workload_kind = 'container' AND fence.workload_id = proof.container_id
       AND fence.lifecycle_revision = proof.lifecycle_revision
       AND fence.effective_at = proof.provider_confirmed_at
       AND fence.billing_state = 'not_billable' AND fence.rate_per_hour = 0
      WHERE proof.organization_id = c.organization_id AND proof.container_id = c.id
        AND proof.provider_confirmed_at IS NOT NULL
        AND c.lifecycle_revision BETWEEN proof.lifecycle_revision AND proof.lifecycle_revision + 2
        AND NOT EXISTS (
          SELECT 1 FROM compute_billing_rate_segments later
          WHERE later.organization_id = c.organization_id AND later.workload_kind = 'container'
            AND later.workload_id = c.id AND later.effective_at > fence.effective_at
            AND later.rate_per_hour > 0
        )
    ) AS stopped_proof
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id ORDER BY effective_at DESC, id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id AND (r.effective_at, r.id) < (latest.effective_at, latest.id)
    ORDER BY effective_at DESC, id DESC LIMIT 1
  ) previous ON true
  WHERE c.status = 'deleting'
), recovery AS (
  SELECT *, CASE
    WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN billing_state
    WHEN billing_state = 'not_billable' AND previous_state = 'running'
      AND latest_revision = previous_revision + 1 THEN 'running'
    ELSE NULL END AS recovered_state,
    CASE WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN rate_per_hour
      WHEN billing_state = 'not_billable' AND previous_state = 'running'
        AND latest_revision = previous_revision + 1 THEN previous_rate
      ELSE NULL END AS recovered_rate
  FROM history
)
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT r.organization_id, 'container', r.id, r.lifecycle_revision,
  r.recovered_state, r.recovered_rate,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), 'deleting'
FROM recovery r JOIN compute_billing_rate_segments latest ON latest.id = r.latest_id
WHERE r.lifecycle_status IS NULL;


-- Correct only future metering for a running, funded subject; settled usage remains immutable.
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT a.organization_id, 'agent', a.id, a.lifecycle_revision,
  'running', funding.hourly_rate,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), a.status
FROM agent_sandboxes a
JOIN agent_compute_funding funding
  ON funding.organization_id = a.organization_id AND funding.agent_id = a.id
  AND funding.settled_at IS NULL AND funding.host_lease_confirmed_at IS NOT NULL
JOIN LATERAL (
  SELECT billing_state, rate_per_hour, effective_at FROM compute_billing_rate_segments s
  WHERE s.organization_id = a.organization_id AND s.workload_kind = 'agent' AND s.workload_id = a.id
  ORDER BY effective_at DESC, id DESC LIMIT 1
) latest ON true
WHERE a.status = 'running' AND a.pool_status IS NULL AND a.execution_tier <> 'shared'
  AND a.deleted_at IS NULL AND latest.billing_state = 'running'
  AND latest.rate_per_hour IS DISTINCT FROM funding.hourly_rate;

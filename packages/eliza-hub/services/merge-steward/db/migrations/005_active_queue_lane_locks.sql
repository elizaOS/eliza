-- Allow one active merge train per lane instead of one active row per lane.
-- Runtime claim code uses transaction-scoped advisory locks around each lane;
-- this index keeps active-lane lookups efficient without blocking train rows.

BEGIN;

DROP INDEX IF EXISTS steward_queue_items_running_lane_idx;

CREATE INDEX IF NOT EXISTS steward_queue_items_active_lane_idx
  ON steward_queue_items (repo, target_branch)
  WHERE queue_state IN ('running', 'building_integration');

CREATE OR REPLACE FUNCTION steward_claim_queue_item(
  p_worker_id text,
  p_now timestamptz DEFAULT now()
) RETURNS steward_queue_items
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_row steward_queue_items%ROWTYPE;
  claimed steward_queue_items%ROWTYPE;
BEGIN
  FOR candidate_row IN
    SELECT *
    FROM steward_queue_items item
    WHERE item.queue_state IN ('queued', 'ready')
      AND (item.available_at IS NULL OR item.available_at <= p_now)
    ORDER BY item.priority DESC, item.risk_score ASC, item.conflict_score ASC, item.updated_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(candidate_row.repo), hashtext(candidate_row.target_branch));

    IF EXISTS (
      SELECT 1
      FROM steward_queue_items active
      WHERE active.repo = candidate_row.repo
        AND active.target_branch = candidate_row.target_branch
        AND active.queue_state IN ('running', 'building_integration')
        AND active.id <> candidate_row.id
    ) THEN
      CONTINUE;
    END IF;

    UPDATE steward_queue_items item
    SET queue_state = 'running',
        claim_owner_id = p_worker_id,
        claimed_at = p_now,
        attempt_count = item.attempt_count + 1,
        last_error = NULL,
        updated_at = p_now
    WHERE item.id = candidate_row.id
    RETURNING item.* INTO claimed;

    RETURN claimed;
  END LOOP;

  RETURN NULL;
END;
$$;

COMMIT;

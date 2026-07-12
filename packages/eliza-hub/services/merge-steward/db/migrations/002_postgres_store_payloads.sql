-- Runtime store compatibility for the Node Postgres adapter.
--
-- The indexed columns keep queue/runtime queries efficient. The payload JSON
-- columns preserve the full object shape used by the JSON staging store so API
-- responses, policy facts, and future agent metadata round-trip safely.

BEGIN;

ALTER TABLE steward_queue_items
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_queue_items
  DROP CONSTRAINT IF EXISTS steward_queue_items_queue_state_check;

ALTER TABLE steward_queue_items
  ADD CONSTRAINT steward_queue_items_queue_state_check CHECK (
    queue_state IN (
      'observed',
      'triaged',
      'queued',
      'ready',
      'waiting_for_review',
      'waiting_for_checks',
      'building_integration',
      'integration_failed',
      'blocked_stale',
      'blocked_conflict',
      'blocked_policy',
      'quarantined',
      'running',
      'merged',
      'failed',
      'cancelled',
      'closed'
    )
  );

ALTER TABLE steward_runs
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_run_nodes
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_attempts
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_run_events
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_approvals
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_human_requests
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_signals
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE steward_webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS steward_events (
  id bigserial PRIMARY KEY,
  delivery_id text,
  type text,
  repo text,
  pull_request_id integer,
  payload_hash text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS steward_events_delivery_id_idx
  ON steward_events (delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_events_repo_idx
  ON steward_events (repo, pull_request_id, received_at DESC)
  WHERE repo IS NOT NULL;

COMMIT;

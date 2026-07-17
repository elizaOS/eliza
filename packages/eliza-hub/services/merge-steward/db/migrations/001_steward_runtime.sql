-- Eliza Merge Steward production runtime schema.
-- Target: PostgreSQL 15+.
--
-- The JSON queue store is for private single-process staging only. These tables
-- are the production authority for queue ownership, run state, worker attempts,
-- human approval/input, signal wakeups, and webhook delivery idempotency.

BEGIN;

CREATE TABLE IF NOT EXISTS steward_queue_items (
  id text PRIMARY KEY,
  repo text NOT NULL,
  pull_request_id integer NOT NULL,
  source_branch text,
  target_branch text NOT NULL DEFAULT '',
  head_sha text,
  queue_state text NOT NULL DEFAULT 'queued' CHECK (
    queue_state IN (
      'queued',
      'ready',
      'waiting_for_review',
      'waiting_for_checks',
      'blocked_stale',
      'blocked_policy',
      'quarantined',
      'running',
      'merged',
      'failed',
      'cancelled',
      'closed'
    )
  ),
  priority integer NOT NULL DEFAULT 0,
  risk_score integer NOT NULL DEFAULT 0,
  conflict_score integer NOT NULL DEFAULT 0,
  author_kind text CHECK (author_kind IN ('human', 'agent', 'bot', 'service')),
  owner_agent_id text,
  task_id text,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  changed_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_packages jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  check_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  claim_owner_id text,
  claimed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo, pull_request_id)
);

CREATE INDEX IF NOT EXISTS steward_queue_items_schedule_idx
  ON steward_queue_items (queue_state, priority DESC, risk_score ASC, conflict_score ASC, updated_at ASC);

CREATE INDEX IF NOT EXISTS steward_queue_items_head_sha_idx
  ON steward_queue_items (head_sha)
  WHERE head_sha IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS steward_queue_items_running_lane_idx
  ON steward_queue_items (repo, target_branch)
  WHERE queue_state = 'running';

CREATE OR REPLACE FUNCTION steward_claim_queue_item(
  p_worker_id text,
  p_now timestamptz DEFAULT now()
) RETURNS steward_queue_items
LANGUAGE plpgsql
AS $$
DECLARE
  claimed steward_queue_items%ROWTYPE;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM steward_queue_items item
    WHERE item.queue_state IN ('queued', 'ready')
      AND (item.available_at IS NULL OR item.available_at <= p_now)
      AND NOT EXISTS (
        SELECT 1
        FROM steward_queue_items running
        WHERE running.repo = item.repo
          AND running.target_branch = item.target_branch
          AND running.queue_state = 'running'
      )
    ORDER BY item.priority DESC, item.risk_score ASC, item.conflict_score ASC, item.updated_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  updated AS (
    UPDATE steward_queue_items item
    SET queue_state = 'running',
        claim_owner_id = p_worker_id,
        claimed_at = p_now,
        attempt_count = item.attempt_count + 1,
        last_error = NULL,
        updated_at = p_now
    FROM candidate
    WHERE item.id = candidate.id
    RETURNING item.*
  )
  SELECT * INTO claimed FROM updated;

  RETURN claimed;
END;
$$;

CREATE TABLE IF NOT EXISTS steward_runs (
  id text PRIMARY KEY,
  repo text,
  queue_item_id text REFERENCES steward_queue_items(id) ON DELETE SET NULL,
  pull_request_id integer,
  source_branch text,
  target_branch text,
  owner_kind text CHECK (owner_kind IN ('human', 'agent', 'service', 'bot')),
  owner_id text,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN (
      'running',
      'waiting_approval',
      'waiting_event',
      'waiting_timer',
      'paused',
      'recovering',
      'finished',
      'failed',
      'cancelled'
    )
  ),
  runtime_owner_id text,
  heartbeat_at timestamptz,
  correlation_key text,
  started_at timestamptz,
  finished_at timestamptz,
  resumed_by_signal_id text,
  resumed_by_approval_id text,
  last_error text,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steward_runs_queue_item_idx
  ON steward_runs (queue_item_id);

CREATE INDEX IF NOT EXISTS steward_runs_status_idx
  ON steward_runs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_runs_correlation_key_idx
  ON steward_runs (correlation_key)
  WHERE correlation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS steward_run_nodes (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES steward_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  iteration integer NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'running',
      'waiting_approval',
      'approval_requested',
      'waiting_event',
      'waiting_timer',
      'recovering',
      'succeeded',
      'failed',
      'cancelled',
      'skipped',
      'blocked'
    )
  ),
  agent_id text,
  model_id text,
  approval_id text,
  correlation_key text,
  signal_type text,
  wake_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by_signal_id text,
  completed_by_approval_id text,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id, iteration)
);

CREATE INDEX IF NOT EXISTS steward_run_nodes_run_status_idx
  ON steward_run_nodes (run_id, status);

CREATE INDEX IF NOT EXISTS steward_run_nodes_correlation_idx
  ON steward_run_nodes (correlation_key)
  WHERE correlation_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS steward_attempts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES steward_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  iteration integer NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN (
      'running',
      'recovering',
      'succeeded',
      'failed',
      'cancelled',
      'blocked',
      'skipped'
    )
  ),
  owner_id text,
  heartbeat_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  available_at timestamptz,
  recovered_from_owner_id text,
  recovered_at timestamptz,
  output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id, iteration, attempt),
  FOREIGN KEY (run_id, node_id, iteration)
    REFERENCES steward_run_nodes(run_id, node_id, iteration)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS steward_attempts_status_heartbeat_idx
  ON steward_attempts (status, heartbeat_at ASC)
  WHERE status IN ('running', 'recovering');

CREATE INDEX IF NOT EXISTS steward_attempts_available_idx
  ON steward_attempts (available_at ASC)
  WHERE status IN ('failed', 'blocked');

CREATE TABLE IF NOT EXISTS steward_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES steward_runs(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq > 0),
  type text NOT NULL,
  queue_item_id text REFERENCES steward_queue_items(id) ON DELETE SET NULL,
  actor_kind text CHECK (actor_kind IN ('human', 'agent', 'service', 'bot')),
  actor_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS steward_run_events_after_seq_idx
  ON steward_run_events (run_id, seq ASC);

CREATE TABLE IF NOT EXISTS steward_approvals (
  id text PRIMARY KEY,
  run_id text REFERENCES steward_runs(id) ON DELETE CASCADE,
  queue_item_id text REFERENCES steward_queue_items(id) ON DELETE SET NULL,
  node_id text NOT NULL DEFAULT 'human_approval',
  iteration integer NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'approved', 'denied', 'expired', 'cancelled')
  ),
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_actors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text,
  decided_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (run_id IS NOT NULL OR queue_item_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS steward_approvals_status_idx
  ON steward_approvals (status, requested_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS steward_approvals_run_node_idx
  ON steward_approvals (run_id, node_id, iteration)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS steward_human_requests (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES steward_runs(id) ON DELETE CASCADE,
  node_id text NOT NULL DEFAULT 'human_input',
  iteration integer NOT NULL DEFAULT 0 CHECK (iteration >= 0),
  kind text NOT NULL DEFAULT 'confirm' CHECK (kind IN ('ask', 'confirm', 'select', 'json')),
  status text NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'answered', 'expired', 'cancelled')
  ),
  prompt text,
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text,
  responded_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id, iteration)
);

CREATE INDEX IF NOT EXISTS steward_human_requests_status_idx
  ON steward_human_requests (status, requested_at ASC);

CREATE TABLE IF NOT EXISTS steward_signals (
  id text PRIMARY KEY,
  run_id text REFERENCES steward_runs(id) ON DELETE SET NULL,
  correlation_key text,
  type text,
  status text NOT NULL DEFAULT 'received' CHECK (
    status IN ('received', 'consumed', 'expired', 'ignored')
  ),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  consumed_by text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (run_id IS NOT NULL OR correlation_key IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS steward_signals_correlation_idx
  ON steward_signals (correlation_key, status, created_at ASC)
  WHERE correlation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_signals_run_idx
  ON steward_signals (run_id, status, created_at ASC)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS steward_webhook_deliveries (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  delivery_id text NOT NULL,
  event_name text,
  repo text,
  pull_request_id integer,
  payload_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received' CHECK (
    processing_status IN ('received', 'gated', 'processed', 'duplicate', 'failed')
  ),
  gate_reason text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, delivery_id)
);

CREATE INDEX IF NOT EXISTS steward_webhook_deliveries_repo_idx
  ON steward_webhook_deliveries (repo, pull_request_id, first_seen_at DESC)
  WHERE repo IS NOT NULL;

CREATE TABLE IF NOT EXISTS steward_repo_policies (
  repo text PRIMARY KEY,
  queue_mode text NOT NULL DEFAULT 'serialized' CHECK (
    queue_mode IN ('disabled', 'serialized', 'batched')
  ),
  protected_branches jsonb NOT NULL DEFAULT '["main","develop"]'::jsonb,
  required_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  trusted_actors jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_forks boolean NOT NULL DEFAULT false,
  policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

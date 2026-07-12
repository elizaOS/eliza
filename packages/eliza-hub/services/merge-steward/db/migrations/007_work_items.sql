BEGIN;

CREATE TABLE IF NOT EXISTS steward_work_items (
  id text PRIMARY KEY,
  repo text NOT NULL,
  kind text NOT NULL DEFAULT 'task',
  state text NOT NULL DEFAULT 'ready',
  title text NOT NULL,
  summary text,
  priority integer NOT NULL DEFAULT 0,
  owner_agent_id text,
  task_id text,
  issue_id text,
  pull_request_id integer,
  source_url text,
  target_branch text,
  paths_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  packages_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  labels_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_work_items_kind_check CHECK (
    kind IN ('task', 'issue', 'pull_request', 'branch', 'path', 'package', 'release', 'incident')
  ),
  CONSTRAINT steward_work_items_state_check CHECK (
    state IN (
      'backlog',
      'ready',
      'claimed',
      'in_progress',
      'needs_human_review',
      'merge_queue',
      'blocked',
      'done',
      'cancelled'
    )
  )
);

CREATE INDEX IF NOT EXISTS steward_work_items_repo_state_idx
  ON steward_work_items (repo, state, priority DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_items_owner_idx
  ON steward_work_items (owner_agent_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_items_kind_idx
  ON steward_work_items (kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_items_task_idx
  ON steward_work_items (repo, task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_items_issue_idx
  ON steward_work_items (repo, issue_id)
  WHERE issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_items_pull_request_idx
  ON steward_work_items (repo, pull_request_id)
  WHERE pull_request_id IS NOT NULL;

COMMIT;

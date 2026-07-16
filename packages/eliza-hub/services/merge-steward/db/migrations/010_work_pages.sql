BEGIN;

CREATE TABLE IF NOT EXISTS steward_work_pages (
  id text PRIMARY KEY,
  repo text NOT NULL,
  kind text NOT NULL DEFAULT 'note',
  state text NOT NULL DEFAULT 'active',
  title text NOT NULL,
  summary text,
  body_text text,
  body_format text NOT NULL DEFAULT 'markdown',
  owner_agent_id text,
  work_item_id text,
  cycle_id text,
  module_id text,
  task_id text,
  issue_id text,
  pull_request_id integer,
  source_url text,
  tags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility text NOT NULL DEFAULT 'private',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_work_pages_kind_check CHECK (
    kind IN ('agent_plan', 'runbook', 'release_note', 'decision', 'spec', 'note')
  ),
  CONSTRAINT steward_work_pages_state_check CHECK (
    state IN ('active', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS steward_work_pages_repo_state_idx
  ON steward_work_pages (repo, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_pages_owner_idx
  ON steward_work_pages (owner_agent_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_pages_kind_idx
  ON steward_work_pages (repo, kind, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_pages_work_item_idx
  ON steward_work_pages (repo, work_item_id, updated_at DESC)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_pages_cycle_idx
  ON steward_work_pages (repo, cycle_id, updated_at DESC)
  WHERE cycle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_pages_module_idx
  ON steward_work_pages (repo, module_id, updated_at DESC)
  WHERE module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_pages_task_idx
  ON steward_work_pages (repo, task_id, updated_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_pages_issue_idx
  ON steward_work_pages (repo, issue_id, updated_at DESC)
  WHERE issue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_pages_pull_request_idx
  ON steward_work_pages (repo, pull_request_id, updated_at DESC)
  WHERE pull_request_id IS NOT NULL;

COMMIT;

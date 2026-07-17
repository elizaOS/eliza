BEGIN;

CREATE TABLE IF NOT EXISTS steward_work_views (
  id text PRIMARY KEY,
  repo text,
  kind text NOT NULL DEFAULT 'list',
  state text NOT NULL DEFAULT 'active',
  title text NOT NULL,
  summary text,
  owner_agent_id text,
  query_text text,
  filters_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  layout_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility text NOT NULL DEFAULT 'private',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_work_views_kind_check CHECK (
    kind IN ('list', 'kanban', 'dashboard', 'calendar', 'timeline', 'spreadsheet', 'search')
  ),
  CONSTRAINT steward_work_views_state_check CHECK (
    state IN ('active', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS steward_work_views_repo_kind_idx
  ON steward_work_views (repo, kind, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_views_owner_idx
  ON steward_work_views (owner_agent_id, state, updated_at DESC);

COMMIT;

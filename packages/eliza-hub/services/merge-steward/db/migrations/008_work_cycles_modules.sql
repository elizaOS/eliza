BEGIN;

CREATE TABLE IF NOT EXISTS steward_work_cycles (
  id text PRIMARY KEY,
  repo text NOT NULL,
  state text NOT NULL DEFAULT 'planned',
  title text NOT NULL,
  summary text,
  owner_agent_id text,
  start_at timestamptz,
  end_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_work_cycles_state_check CHECK (
    state IN ('planned', 'active', 'completed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS steward_work_cycles_repo_state_idx
  ON steward_work_cycles (repo, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_cycles_owner_idx
  ON steward_work_cycles (owner_agent_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS steward_work_modules (
  id text PRIMARY KEY,
  repo text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  title text NOT NULL,
  summary text,
  owner_agent_id text,
  paths_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  packages_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  labels_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT steward_work_modules_state_check CHECK (
    state IN ('active', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS steward_work_modules_repo_state_idx
  ON steward_work_modules (repo, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_work_modules_owner_idx
  ON steward_work_modules (owner_agent_id, state, updated_at DESC);

ALTER TABLE steward_work_items
  ADD COLUMN IF NOT EXISTS cycle_id text,
  ADD COLUMN IF NOT EXISTS module_id text;

CREATE INDEX IF NOT EXISTS steward_work_items_cycle_idx
  ON steward_work_items (repo, cycle_id, state, updated_at DESC)
  WHERE cycle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_work_items_module_idx
  ON steward_work_items (repo, module_id, state, updated_at DESC)
  WHERE module_id IS NOT NULL;

COMMIT;

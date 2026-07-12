-- Agent work claims and leases.
--
-- Claims let Eliza agents coordinate ownership of issues, PRs, branches, paths,
-- packages, or task ids without relying on only Forgejo labels.

BEGIN;

CREATE TABLE IF NOT EXISTS steward_agent_claims (
  id text PRIMARY KEY,
  repo text NOT NULL,
  resource_kind text NOT NULL CHECK (
    resource_kind IN (
      'issue',
      'pull_request',
      'branch',
      'path',
      'package',
      'task',
      'queue_item'
    )
  ),
  resource_id text NOT NULL,
  owner_agent_id text NOT NULL,
  task_id text,
  run_id text,
  branch text,
  paths_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'released', 'expired', 'cancelled')
  ),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  released_at timestamptz,
  release_reason text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo, resource_kind, resource_id)
);

CREATE INDEX IF NOT EXISTS steward_agent_claims_active_idx
  ON steward_agent_claims (repo, resource_kind, expires_at ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS steward_agent_claims_owner_idx
  ON steward_agent_claims (owner_agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS steward_agent_claims_run_idx
  ON steward_agent_claims (run_id)
  WHERE run_id IS NOT NULL;

COMMIT;

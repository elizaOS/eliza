-- Steward-owned allowed agent identity registry.
--
-- Eliza Cloud can sync agent/service identities here so strict merge policy can
-- trust steward-owned state instead of PR-supplied agentKnown facts.

BEGIN;

CREATE TABLE IF NOT EXISTS steward_registered_agents (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled', 'revoked')
  ),
  display_name text,
  forgejo_username text,
  eliza_cloud_subject text,
  tenant_id text,
  source text NOT NULL DEFAULT 'steward',
  registered_by text,
  registered_at timestamptz NOT NULL DEFAULT now(),
  disabled_by text,
  disabled_at timestamptz,
  disable_reason text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steward_registered_agents_active_idx
  ON steward_registered_agents (id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS steward_registered_agents_tenant_idx
  ON steward_registered_agents (tenant_id, status, id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS steward_registered_agents_subject_idx
  ON steward_registered_agents (eliza_cloud_subject)
  WHERE eliza_cloud_subject IS NOT NULL;

COMMIT;

-- One canonical Personal Shared agent may be explicitly bound to provider groups.

CREATE TABLE personal_shared_group_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  personal_agent_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('telegram', 'blooio')),
  project text NOT NULL,
  connector_account_id text NOT NULL,
  issued_to_platform_user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX personal_shared_group_claims_expires_idx
  ON personal_shared_group_claims (expires_at);
CREATE INDEX personal_shared_group_claims_owner_idx
  ON personal_shared_group_claims (owner_user_id, platform);

CREATE TABLE personal_shared_group_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  personal_agent_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('telegram', 'blooio')),
  project text NOT NULL,
  connector_account_id text NOT NULL,
  provider_chat_id text NOT NULL,
  conversation_id text NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'suspended', 'revoked')),
  response_policy text NOT NULL DEFAULT 'mention_only'
    CHECK (response_policy IN ('mention_only', 'ambient')),
  created_by_platform_user_id text NOT NULL,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX personal_shared_group_bindings_provider_chat_uidx
  ON personal_shared_group_bindings
  (platform, project, connector_account_id, provider_chat_id);
CREATE INDEX personal_shared_group_bindings_owner_idx
  ON personal_shared_group_bindings (owner_user_id, state);

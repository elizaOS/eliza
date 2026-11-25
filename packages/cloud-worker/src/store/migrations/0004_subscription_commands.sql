CREATE TABLE subscription_commands (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  kind text NOT NULL CHECK (kind IN ('cancel', 'undo', 'upgrade', 'downgrade')),
  status text NOT NULL CHECK (status IN ('prepared', 'dispatched', 'unknown', 'succeeded', 'rejected')),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  result_revision bigint CHECK (result_revision >= expected_revision),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX subscription_commands_owner_page ON subscription_commands (organization_id, created_at DESC, key DESC);

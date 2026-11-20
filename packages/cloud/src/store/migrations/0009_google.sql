CREATE TABLE google_connections (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL REFERENCES accounts (key),
  subject text NOT NULL,
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('Pending', 'Active', 'Expired', 'Revoked', 'Error')),
  tokens text,
  expires_at bigint NOT NULL DEFAULT 0,
  refreshing_until bigint NOT NULL DEFAULT 0,
  linked_at bigint NOT NULL,
  last_used_at bigint,
  UNIQUE (organization_id, subject),
  CHECK ((status IN ('Expired', 'Revoked')) <= (tokens IS NULL))
);

CREATE INDEX google_connections_by_status ON google_connections (organization_id, status);

CREATE TABLE google_connect_states (
  state_digest text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL REFERENCES accounts (key),
  capabilities jsonb NOT NULL,
  redirect_url text,
  verifier text NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint
);

CREATE INDEX google_connect_states_by_expiry ON google_connect_states (expires_at);

CREATE TABLE mail_operations (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL REFERENCES accounts (key),
  grant_id text NOT NULL,
  request_id text NOT NULL,
  kind text NOT NULL,
  review_digest text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared', 'dispatched', 'succeeded', 'rejected', 'outcome-unknown')),
  dispatched_at bigint,
  provider_result jsonb,
  updated_at bigint NOT NULL
);

CREATE INDEX mail_operations_stale ON mail_operations (phase, dispatched_at);

CREATE TABLE calendar_writes (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL REFERENCES accounts (key),
  grant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  kind text NOT NULL,
  calendar_id text NOT NULL,
  event_id text,
  if_match text,
  request jsonb,
  etag text,
  rejection text,
  phase text NOT NULL,
  stale_after bigint,
  updated_at bigint NOT NULL
);

CREATE INDEX calendar_writes_stale ON calendar_writes (phase, stale_after);

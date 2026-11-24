CREATE TABLE cloud_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  created_at bigint NOT NULL
);

CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  credit_balance bigint NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  created_at bigint NOT NULL
);

CREATE TABLE accounts (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL UNIQUE REFERENCES organizations (id),
  status text NOT NULL CHECK (status IN ('active', 'deleting', 'erased')),
  email text UNIQUE,
  phone text UNIQUE,
  name text,
  sessions_revoked_before bigint NOT NULL DEFAULT 0,
  devices_revoked_before bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE sessions (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  user_id text NOT NULL REFERENCES accounts (key),
  access_digest text NOT NULL UNIQUE,
  refresh_digest text NOT NULL UNIQUE,
  live boolean NOT NULL,
  access_expires_at bigint NOT NULL,
  refresh_expires_at bigint NOT NULL,
  auth_at bigint NOT NULL,
  step_up_at bigint NOT NULL DEFAULT 0,
  mfa_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_refresh_sweep ON sessions (refresh_expires_at) WHERE live;

CREATE TABLE device_grants (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  user_id text NOT NULL REFERENCES accounts (key),
  client_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('code_issued', 'exchanged', 'active', 'expired', 'ended')),
  code_digest text UNIQUE,
  credential_id text UNIQUE,
  secret_digest text UNIQUE,
  device_name text,
  code_expires_at bigint NOT NULL,
  key_expires_at bigint NOT NULL DEFAULT 0,
  issued_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX device_grants_user ON device_grants (user_id);
CREATE INDEX device_grants_cleanup ON device_grants (phase, code_expires_at);

CREATE TABLE funds (
  key text PRIMARY KEY REFERENCES organizations (id),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE credit_entries (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id),
  kind text NOT NULL CHECK (kind IN ('add', 'settle')),
  amount bigint NOT NULL,
  request_key text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (organization_id, kind, request_key)
);

CREATE TABLE holds (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL,
  service text NOT NULL CHECK (service IN ('inference', 'speech', 'maps')),
  phase text NOT NULL CHECK (phase IN ('reserved', 'dispatched', 'settled', 'released')),
  allowance_period text,
  created_at bigint NOT NULL,
  dispatched_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX holds_sweep ON holds (phase, created_at) WHERE phase IN ('reserved', 'dispatched');
CREATE INDEX holds_organization ON holds (organization_id);

CREATE TABLE usage_records (
  hold_key text PRIMARY KEY REFERENCES holds (key),
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL,
  service text NOT NULL,
  quote bigint NOT NULL,
  charged bigint NOT NULL,
  from_allowance bigint NOT NULL,
  from_credits bigint NOT NULL,
  uncollected bigint NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('known', 'unknown', 'released')),
  settled_at bigint NOT NULL
);
CREATE INDEX usage_records_organization ON usage_records (organization_id, settled_at);

CREATE TABLE subscriptions (
  key text PRIMARY KEY REFERENCES organizations (id),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('none', 'pending', 'incomplete', 'active', 'dunning', 'past_due', 'unpaid', 'canceled', 'incomplete_expired')),
  plan_key text NOT NULL,
  customer_id text UNIQUE,
  provider_subscription_id text UNIQUE,
  period_end bigint NOT NULL DEFAULT 0,
  stale_after bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX subscriptions_reconcile ON subscriptions (stale_after);

CREATE TABLE allowance_periods (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  status text NOT NULL CHECK (status IN ('open', 'expired', 'closed', 'clawed_back')),
  period_start bigint NOT NULL,
  period_end bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX allowance_periods_open ON allowance_periods (organization_id, period_end) WHERE status = 'open';

CREATE TABLE grants (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id),
  family text NOT NULL,
  plan_key text NOT NULL,
  effective_from bigint NOT NULL,
  effective_until bigint NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  UNIQUE (organization_id, family),
  CHECK (effective_from < effective_until)
);
CREATE INDEX grants_effective ON grants (organization_id, effective_until) WHERE NOT revoked;

CREATE TABLE rate_windows (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  window_end bigint NOT NULL
);
CREATE INDEX rate_windows_end ON rate_windows (window_end);

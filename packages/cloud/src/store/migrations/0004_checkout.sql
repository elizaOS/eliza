CREATE TABLE checkouts (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL REFERENCES organizations (id),
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  digest text NOT NULL,
  plan_key text NOT NULL CHECK (plan_key IN ('plus_monthly', 'pro_monthly')),
  presentation text NOT NULL CHECK (presentation IN ('mobile', 'embedded', 'shared')),
  provider_session_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('not_started', 'opening', 'open', 'completed', 'expired')),
  session_expires_at bigint NOT NULL,
  readback_attempt integer NOT NULL DEFAULT 0 CHECK (readback_attempt >= 0),
  next_readback_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX checkouts_readback_due ON checkouts (next_readback_at, key) WHERE status IN ('opening', 'open');
CREATE UNIQUE INDEX checkouts_one_live ON checkouts (organization_id) WHERE status IN ('opening', 'open');

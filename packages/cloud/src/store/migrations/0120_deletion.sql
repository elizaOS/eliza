CREATE TABLE deletion_requests (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  organization_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('running', 'action_needed', 'erased')),
  step text NOT NULL CHECK (step IN ('cancel_billing', 'revoke_google', 'erase_data')),
  attempts integer NOT NULL CHECK (attempts >= 0),
  claim_expires_at bigint NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX deletion_requests_due ON deletion_requests (claim_expires_at, updated_at) WHERE phase = 'running';

CREATE TABLE deletion_receipts (
  provider_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES deletion_requests (key),
  step text NOT NULL CHECK (step IN ('cancel_billing', 'revoke_google')),
  target text NOT NULL,
  state jsonb NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX deletion_receipts_user ON deletion_receipts (user_id, step, updated_at);

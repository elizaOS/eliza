CREATE TABLE IF NOT EXISTS cloud_google_connections (
  account_id text PRIMARY KEY REFERENCES accounts(key) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  subject text NOT NULL UNIQUE,
  email text NOT NULL,
  mail boolean NOT NULL,
  calendar boolean NOT NULL,
  refresh_cipher text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT cloud_google_scope_present CHECK (mail OR calendar)
);

CREATE TABLE IF NOT EXISTS cloud_google_authorizations (
  account_id text PRIMARY KEY REFERENCES accounts(key) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  expected_email text,
  mail boolean NOT NULL,
  calendar boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT cloud_google_authorization_scope_present CHECK (mail OR calendar)
);

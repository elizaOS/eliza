CREATE TABLE IF NOT EXISTS cloud_sign_in_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'email', 'sms')),
  provider_subject text NOT NULL,
  account_id text NOT NULL REFERENCES accounts(key),
  PRIMARY KEY (provider, provider_subject),
  UNIQUE (account_id, provider)
);

CREATE TABLE IF NOT EXISTS cloud_spent_refresh (
  digest text PRIMARY KEY,
  access_digest text NOT NULL UNIQUE,
  session_key text NOT NULL REFERENCES sessions(key),
  generation integer NOT NULL CHECK (generation > 0)
);

CREATE INDEX IF NOT EXISTS cloud_spent_refresh_session_idx ON cloud_spent_refresh(session_key);

CREATE TABLE IF NOT EXISTS cloud_device_proofs (
  grant_key text PRIMARY KEY REFERENCES device_grants(key) ON DELETE CASCADE,
  session_key text NOT NULL REFERENCES sessions(key),
  challenge text NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_email_codes (
  email text PRIMARY KEY,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  tries integer NOT NULL CHECK (tries BETWEEN 0 AND 5)
);

CREATE TABLE IF NOT EXISTS cloud_auth_limits (
  scope text NOT NULL,
  subject_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (scope, subject_hash)
);

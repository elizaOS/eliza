CREATE TABLE IF NOT EXISTS oauth_attempts (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  challenge_digest text,
  nonce_digest text,
  expires_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_attempts_expiry ON oauth_attempts (expires_at);

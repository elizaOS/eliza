CREATE TABLE cloud_native_google_challenges (
  key uuid PRIMARY KEY,
  client_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  redirect_uri text NOT NULL,
  audience text NOT NULL,
  nonce_digest text NOT NULL,
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL CHECK (length(state) BETWEEN 43 AND 128),
  expires_at bigint NOT NULL
);

CREATE INDEX cloud_native_google_challenges_expiry ON cloud_native_google_challenges (expires_at);

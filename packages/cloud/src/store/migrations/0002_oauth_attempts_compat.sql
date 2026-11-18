ALTER TABLE oauth_attempts
  ADD COLUMN IF NOT EXISTS route text CHECK (route IN ('browser', 'native')),
  ADD COLUMN IF NOT EXISTS app_state text,
  ADD COLUMN IF NOT EXISTS state_digest text UNIQUE,
  ADD COLUMN IF NOT EXISTS google_verifier text,
  ADD COLUMN IF NOT EXISTS link_user_id text REFERENCES accounts (key) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS code_digest text UNIQUE,
  ADD COLUMN IF NOT EXISTS google_subject text,
  ADD COLUMN IF NOT EXISTS verified_email text,
  ADD COLUMN IF NOT EXISTS given_name text,
  ADD COLUMN IF NOT EXISTS pending boolean;

UPDATE oauth_attempts
SET route = COALESCE(route, 'browser'),
    pending = false
WHERE route IS NULL OR pending IS NULL;

ALTER TABLE oauth_attempts
  ALTER COLUMN route SET NOT NULL,
  ALTER COLUMN redirect_uri DROP NOT NULL,
  ALTER COLUMN pending SET NOT NULL;

CREATE INDEX IF NOT EXISTS oauth_attempts_due ON oauth_attempts (expires_at) WHERE pending;

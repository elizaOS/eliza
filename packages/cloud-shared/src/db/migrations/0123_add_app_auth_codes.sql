-- Single-use app authorization codes for the `Authorize this app` consent
-- flow. Replaces the cache-backed `eac_*` store so the flow keeps working
-- in Workers prod where CACHE_ENABLED=false.
--
-- Only the SHA-256 hash of the code is stored; plaintext is returned to the
-- caller once. Codes are single-use (deleted on consume) with a 5-minute TTL;
-- expired rows are pruned by the `cleanup-expired-app-auth-codes` cron.

CREATE TABLE IF NOT EXISTS app_auth_codes (
  code_hash   TEXT PRIMARY KEY,
  app_id      UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS app_auth_codes_expires_at_idx ON app_auth_codes (expires_at);
CREATE INDEX IF NOT EXISTS app_auth_codes_app_id_idx ON app_auth_codes (app_id);
CREATE INDEX IF NOT EXISTS app_auth_codes_user_id_idx ON app_auth_codes (user_id);

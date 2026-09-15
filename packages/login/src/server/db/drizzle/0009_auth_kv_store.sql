-- Migration: auth_kv_store
-- Persistent key-value store for WebAuthn challenges and magic-link tokens.
-- Used when Redis is unavailable but Postgres-backed persistence is desired.
-- Both tables share a single auth_kv_store table partitioned by namespace.

CREATE TABLE IF NOT EXISTS auth_kv_store (
  id          TEXT        NOT NULL,
  namespace   TEXT        NOT NULL,
  value       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, namespace)
);

-- Index for efficient expired-row cleanup queries
CREATE INDEX IF NOT EXISTS auth_kv_store_expires_idx
  ON auth_kv_store (expires_at);

-- Optional: schedule a periodic sweep to remove fully-expired entries.
-- Application code also deletes rows lazily on read, so this is optional.
-- Example (requires pg_cron extension):
-- SELECT cron.schedule('auth-kv-cleanup', '*/10 * * * *',
--   $$DELETE FROM auth_kv_store WHERE expires_at < now()$$);

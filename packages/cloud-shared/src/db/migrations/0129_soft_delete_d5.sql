-- D-5: Soft-delete (`deleted_at`) on user-scoped tables.
--
-- All adds are IF NOT EXISTS so this is safe to re-run.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS users_deleted_at_idx ON users(deleted_at);

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS conversations_deleted_at_idx ON conversations(deleted_at);

ALTER TABLE secrets
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS secrets_deleted_at_idx ON secrets(deleted_at);

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS api_keys_deleted_at_idx ON api_keys(deleted_at);

ALTER TABLE agent_sandboxes
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS agent_sandboxes_deleted_at_idx ON agent_sandboxes(deleted_at);

ALTER TABLE vendor_connections
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS vendor_connections_deleted_at_idx ON vendor_connections(deleted_at);

ALTER TABLE platform_credentials
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS platform_credentials_deleted_at_idx ON platform_credentials(deleted_at);

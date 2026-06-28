-- D-6: Remove `api_key_plain` from cli_auth_sessions.
--
-- The CLI no longer reads a plaintext column from this table. The
-- replacement is a single-use signed-token endpoint (TODO at
-- packages/cloud-api/src/routes/v1/cli-auth.ts) that decrypts the
-- api_keys row in-memory and marks `consumed_at`.

ALTER TABLE cli_auth_sessions
    DROP COLUMN IF EXISTS api_key_plain,
    ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP;

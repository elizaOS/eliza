-- D-1: Encrypt API-key plaintext at rest.
--
-- We keep the SHA-256 `key_hash` (used for fast auth lookup) and add KMS
-- envelope columns for the plaintext. The plaintext `key` column is
-- replaced by the encrypted columns. AAD on encrypt is
-- "api_keys|<id>|key", binding ciphertext to the row.
--
-- Backfill of existing rows is NOT done here. The current `key` column
-- already stored plaintext; an out-of-band backfill job will encrypt
-- those rows and then a follow-up migration will DROP the plaintext
-- column. New rows written through ApiKeysService populate the
-- encrypted columns directly.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS key_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS key_nonce TEXT,
    ADD COLUMN IF NOT EXISTS key_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS key_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS key_kms_key_version INTEGER;

-- The legacy plaintext column. Drop the unique constraint + index that
-- referenced it; the column itself is dropped in a follow-up migration
-- once the backfill has run in production.
DROP INDEX IF EXISTS api_keys_key_idx;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_key_unique;
ALTER TABLE api_keys DROP COLUMN IF EXISTS key;

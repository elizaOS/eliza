-- D-3: Extend field-level encryption to PII.
--
-- Adds ciphertext/nonce/auth_tag/kms_key_id/kms_key_version columns for
-- each encrypted PII field, plus deterministic blind-index hash columns
-- for the fields we still need to look up by equality (email, phone,
-- wallet). All new columns are nullable during rollout; the plaintext
-- column is kept until a follow-up backfill+drop migration.

-- users -----------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS email_nonce TEXT,
    ADD COLUMN IF NOT EXISTS email_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS email_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS email_kms_key_version INTEGER,
    ADD COLUMN IF NOT EXISTS email_blind_index TEXT,

    ADD COLUMN IF NOT EXISTS phone_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS phone_nonce TEXT,
    ADD COLUMN IF NOT EXISTS phone_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS phone_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS phone_kms_key_version INTEGER,
    ADD COLUMN IF NOT EXISTS phone_blind_index TEXT,

    ADD COLUMN IF NOT EXISTS wallet_address_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS wallet_address_nonce TEXT,
    ADD COLUMN IF NOT EXISTS wallet_address_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS wallet_address_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS wallet_address_kms_key_version INTEGER,
    ADD COLUMN IF NOT EXISTS wallet_address_blind_index TEXT,

    ADD COLUMN IF NOT EXISTS telegram_id_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS telegram_id_nonce TEXT,
    ADD COLUMN IF NOT EXISTS telegram_id_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS telegram_id_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS telegram_id_kms_key_version INTEGER,

    ADD COLUMN IF NOT EXISTS discord_id_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS discord_id_nonce TEXT,
    ADD COLUMN IF NOT EXISTS discord_id_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS discord_id_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS discord_id_kms_key_version INTEGER;

CREATE INDEX IF NOT EXISTS users_email_blind_index_idx ON users(email_blind_index);
CREATE INDEX IF NOT EXISTS users_phone_blind_index_idx ON users(phone_blind_index);
CREATE INDEX IF NOT EXISTS users_wallet_blind_index_idx ON users(wallet_address_blind_index);

-- platform_credentials --------------------------------------------------
ALTER TABLE platform_credentials
    ADD COLUMN IF NOT EXISTS platform_user_id_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS platform_user_id_nonce TEXT,
    ADD COLUMN IF NOT EXISTS platform_user_id_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS platform_user_id_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS platform_user_id_kms_key_version INTEGER,

    ADD COLUMN IF NOT EXISTS platform_email_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS platform_email_nonce TEXT,
    ADD COLUMN IF NOT EXISTS platform_email_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS platform_email_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS platform_email_kms_key_version INTEGER,

    ADD COLUMN IF NOT EXISTS platform_display_name_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS platform_display_name_nonce TEXT,
    ADD COLUMN IF NOT EXISTS platform_display_name_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS platform_display_name_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS platform_display_name_kms_key_version INTEGER;

-- conversation_messages.content ----------------------------------------
ALTER TABLE conversation_messages
    ADD COLUMN IF NOT EXISTS content_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS content_nonce TEXT,
    ADD COLUMN IF NOT EXISTS content_auth_tag TEXT,
    ADD COLUMN IF NOT EXISTS content_kms_key_id TEXT,
    ADD COLUMN IF NOT EXISTS content_kms_key_version INTEGER;

-- =====================================================================
-- Idempotent re-encryption hook.
--
-- We do NOT iterate over rows here — Drizzle migrations run inside a
-- single transaction and cannot call into the KMS. The actual backfill
-- of existing rows is performed by an out-of-band job at
-- packages/cloud/api/src/jobs/encrypt-pii-backfill.ts (TODO) which:
--   1. SELECTs rows where ciphertext IS NULL and plaintext IS NOT NULL
--      in batches of 500.
--   2. Calls the per-table crypto helpers in
--      packages/cloud/shared/src/db/crypto/.
--   3. UPDATEs the row WHERE ciphertext IS NULL (idempotent).
--   4. Continues until no rows remain.
-- A follow-up migration drops the plaintext columns once backfill is
-- verified complete in production.
-- =====================================================================

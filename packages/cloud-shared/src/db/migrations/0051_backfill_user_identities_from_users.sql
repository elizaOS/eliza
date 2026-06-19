-- Migration: Backfill missing user_identities rows from legacy users columns
-- Purpose: Insert identity projection rows for legacy users that do not have one
-- Note: user_identities intentionally does not store email, so users.email
-- remains canonical and is not copied here.
-- This is a one-time backfill. The correlated NOT EXISTS checks trade some
-- runtime for conservative conflict avoidance while the table catches up.

WITH source_users AS (
  SELECT
    u.id AS user_id, NULLIF(BTRIM(u.privy_user_id), '') AS privy_user_id,
    u.is_anonymous, NULLIF(BTRIM(u.anonymous_session_id), '') AS anonymous_session_id, u.expires_at,
    NULLIF(BTRIM(u.telegram_id), '') AS telegram_id, NULLIF(BTRIM(u.telegram_username), '') AS telegram_username,
    NULLIF(BTRIM(u.telegram_first_name), '') AS telegram_first_name, NULLIF(BTRIM(u.telegram_photo_url), '') AS telegram_photo_url,
    NULLIF(BTRIM(u.phone_number), '') AS phone_number, u.phone_verified,
    NULLIF(BTRIM(u.discord_id), '') AS discord_id, NULLIF(BTRIM(u.discord_username), '') AS discord_username,
    NULLIF(BTRIM(u.discord_global_name), '') AS discord_global_name, NULLIF(BTRIM(u.discord_avatar_url), '') AS discord_avatar_url,
    NULLIF(BTRIM(u.whatsapp_id), '') AS whatsapp_id, NULLIF(BTRIM(u.whatsapp_name), '') AS whatsapp_name,
    u.created_at, u.updated_at,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.privy_user_id), '')) AS privy_user_id_count,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.anonymous_session_id), '')) AS anonymous_session_id_count,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.telegram_id), '')) AS telegram_id_count,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.phone_number), '')) AS phone_number_count,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.discord_id), '')) AS discord_id_count,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.whatsapp_id), '')) AS whatsapp_id_count
  FROM "users" u
  LEFT JOIN "user_identities" existing_identity ON existing_identity.user_id = u.id
  WHERE existing_identity.user_id IS NULL
), resolved_users AS (
  SELECT
    su.user_id,
    CASE WHEN su.privy_user_id IS NOT NULL AND su.privy_user_id_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.privy_user_id = su.privy_user_id
    ) THEN su.privy_user_id ELSE NULL END AS privy_user_id,
    su.is_anonymous,
    CASE WHEN su.anonymous_session_id IS NOT NULL AND su.anonymous_session_id_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.anonymous_session_id = su.anonymous_session_id
    ) THEN su.anonymous_session_id ELSE NULL END AS anonymous_session_id,
    su.expires_at,
    CASE WHEN su.telegram_id IS NOT NULL AND su.telegram_id_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.telegram_id = su.telegram_id
    ) THEN su.telegram_id ELSE NULL END AS telegram_id,
    su.telegram_username, su.telegram_first_name, su.telegram_photo_url,
    CASE WHEN su.phone_number IS NOT NULL AND su.phone_number_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.phone_number = su.phone_number
    ) THEN su.phone_number ELSE NULL END AS phone_number,
    su.phone_verified,
    CASE WHEN su.discord_id IS NOT NULL AND su.discord_id_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.discord_id = su.discord_id
    ) THEN su.discord_id ELSE NULL END AS discord_id,
    su.discord_username, su.discord_global_name, su.discord_avatar_url,
    CASE WHEN su.whatsapp_id IS NOT NULL AND su.whatsapp_id_count = 1 AND NOT EXISTS (
      SELECT 1 FROM "user_identities" ui WHERE ui.whatsapp_id = su.whatsapp_id
    ) THEN su.whatsapp_id ELSE NULL END AS whatsapp_id,
    su.whatsapp_name, su.created_at, su.updated_at
  FROM source_users su
)
INSERT INTO "user_identities" (
  "user_id", "privy_user_id", "is_anonymous", "anonymous_session_id", "expires_at",
  "telegram_id", "telegram_username", "telegram_first_name", "telegram_photo_url",
  "phone_number", "phone_verified", "discord_id", "discord_username", "discord_global_name",
  "discord_avatar_url", "whatsapp_id", "whatsapp_name", "created_at", "updated_at"
)
SELECT
  ru.user_id, ru.privy_user_id, ru.is_anonymous, ru.anonymous_session_id, ru.expires_at,
  ru.telegram_id,
  CASE WHEN ru.telegram_id IS NOT NULL THEN ru.telegram_username END,
  CASE WHEN ru.telegram_id IS NOT NULL THEN ru.telegram_first_name END,
  CASE WHEN ru.telegram_id IS NOT NULL THEN ru.telegram_photo_url END,
  ru.phone_number,
  CASE WHEN ru.phone_number IS NOT NULL THEN ru.phone_verified END,
  ru.discord_id,
  CASE WHEN ru.discord_id IS NOT NULL THEN ru.discord_username END,
  CASE WHEN ru.discord_id IS NOT NULL THEN ru.discord_global_name END,
  CASE WHEN ru.discord_id IS NOT NULL THEN ru.discord_avatar_url END,
  ru.whatsapp_id,
  CASE WHEN ru.whatsapp_id IS NOT NULL THEN ru.whatsapp_name END,
  ru.created_at, ru.updated_at
FROM resolved_users ru
WHERE ru.privy_user_id IS NOT NULL OR ru.is_anonymous = TRUE OR ru.anonymous_session_id IS NOT NULL
   OR ru.expires_at IS NOT NULL OR ru.telegram_id IS NOT NULL OR ru.phone_number IS NOT NULL
   OR ru.discord_id IS NOT NULL OR ru.whatsapp_id IS NOT NULL
ON CONFLICT DO NOTHING;

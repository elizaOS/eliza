-- Migration: Repair stale Privy claims on existing user_identities rows
-- Purpose: Clear stale claims and reassign safe ones atomically in one statement
-- Note: PostgreSQL CTEs are snapshot-based, so the NOT EXISTS check below does
-- not observe the NULLs written by nulled_existing_privy_repairs directly.
-- Correctness comes from excluding rows that are themselves in the repair set
-- via the LEFT JOIN existing_privy_repairs ... IS NULL filter.

WITH existing_privy_repairs AS (
  SELECT
    ui.user_id,
    NULLIF(BTRIM(u.privy_user_id), '') AS privy_user_id,
    COUNT(*) OVER (PARTITION BY NULLIF(BTRIM(u.privy_user_id), '')) AS privy_user_id_count
  FROM "user_identities" ui
  JOIN "users" u ON u.id = ui.user_id
  WHERE NULLIF(BTRIM(u.privy_user_id), '')
    IS DISTINCT FROM NULLIF(BTRIM(ui.privy_user_id), '')
), nulled_existing_privy_repairs AS (
  UPDATE "user_identities" ui
  SET "privy_user_id" = NULL, "updated_at" = NOW()
  FROM existing_privy_repairs epr
  WHERE ui.user_id = epr.user_id
  RETURNING ui.user_id
), resolved_existing_privy_repairs AS (
  SELECT epr.user_id, epr.privy_user_id
  FROM existing_privy_repairs epr
  JOIN nulled_existing_privy_repairs npr ON npr.user_id = epr.user_id
  WHERE epr.privy_user_id IS NOT NULL
    -- If multiple rows in the repair set claim the same canonical Privy ID,
    -- leave them NULL here and require manual cleanup instead of guessing.
    AND epr.privy_user_id_count = 1
    AND NOT EXISTS (
      SELECT 1
      FROM "user_identities" other_ui
      LEFT JOIN existing_privy_repairs other_epr ON other_epr.user_id = other_ui.user_id
      WHERE other_ui.privy_user_id = epr.privy_user_id
        AND other_ui.user_id <> epr.user_id
        AND other_epr.user_id IS NULL
    )
)
UPDATE "user_identities" ui
SET "privy_user_id" = repr.privy_user_id, "updated_at" = NOW()
FROM resolved_existing_privy_repairs repr
WHERE ui.user_id = repr.user_id;

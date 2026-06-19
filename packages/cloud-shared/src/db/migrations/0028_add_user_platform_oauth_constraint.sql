-- ELIZA-1011: Enforce single OAuth per platform per user
-- This migration:
-- 1. Cleans up existing duplicate connections (keeps most recent, revokes older)
-- 2. Adds partial unique index on (user_id, platform) WHERE user_id IS NOT NULL

-- Step 1: Detach duplicate connections for the same user/platform
-- Keep the most recently used/linked connection, null out user_id on all others
-- Must cover ALL statuses (not just active) since the unique index applies to
-- all rows WHERE user_id IS NOT NULL regardless of status
WITH ranked_connections AS (
  SELECT
    id,
    user_id,
    platform,
    status,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, platform
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        COALESCE(last_used_at, linked_at, updated_at, created_at) DESC
    ) as rn
  FROM platform_credentials
  WHERE user_id IS NOT NULL
),
duplicates AS (
  SELECT id, status
  FROM ranked_connections
  WHERE rn > 1
)
UPDATE platform_credentials pc
SET
  status = CASE WHEN d.status = 'active' THEN 'revoked' ELSE d.status END,
  revoked_at = CASE WHEN d.status = 'active' THEN NOW() ELSE pc.revoked_at END,
  updated_at = NOW(),
  user_id = NULL,
  -- Null secret references to avoid orphaned tokens after detaching duplicates.
  access_token_secret_id = NULL,
  refresh_token_secret_id = NULL,
  error_message = COALESCE(pc.error_message, '[Migration 0028] Detached duplicate user/platform connection')
FROM duplicates d
WHERE pc.id = d.id;

-- Step 2: Create partial unique index to enforce single OAuth per user per platform
-- NULL user_ids are allowed (org-level connections without specific user)
CREATE UNIQUE INDEX IF NOT EXISTS platform_credentials_user_platform_idx
ON platform_credentials (organization_id, user_id, platform)
WHERE user_id IS NOT NULL;

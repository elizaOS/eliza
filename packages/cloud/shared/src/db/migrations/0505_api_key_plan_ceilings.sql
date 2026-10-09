-- #22958: API keys are free, and the number of user-created keys is limited
-- per plan (pay-as-you-go 5, Plus 10, Pro 25). Only keys a user creates
-- through the API-key management surface count; system-provisioned
-- credentials (per-member default keys, the API Explorer key, sign-in keys,
-- app keys and agent-sandbox keys) never do.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "user_created" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: live keys that were not provisioned by the system are treated as
-- user-created. Organizations already above their ceiling keep every key;
-- they can create another only after dropping below it.
UPDATE "api_keys" AS existing
SET "user_created" = true
WHERE existing."deleted_at" IS NULL
  AND existing."user_created" = false
  AND existing."source_app_id" IS NULL
  AND existing."name" NOT LIKE 'agent-sandbox:%'
  AND existing."name" NOT LIKE '% - App API Key'
  AND existing."name" NOT IN (
    'Default API Key',
    'API Explorer Key',
    'SIWE sign-in',
    'SIWS sign-in',
    'Eliza App Default Key'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "apps" WHERE "apps"."api_key_id" = existing."id"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_user_created_org_idx"
  ON "api_keys" ("organization_id")
  WHERE "user_created" AND "deleted_at" IS NULL;

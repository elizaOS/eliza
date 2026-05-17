-- Migration: finalize app_databases consolidation
--
-- Backfills canonical app database provisioning state from the legacy
-- apps.user_database_* columns, verifies that no legacy-only data would be
-- lost, then drops the legacy columns from apps.
--
-- Rows where the only legacy value is user_database_region are treated as
-- empty. The original apps.user_database_region column had a default, so old
-- apps can contain "aws-us-east-1" without ever having had a provisioned DB.

BEGIN;

DO $$
DECLARE
  legacy_columns_present BOOLEAN;
  unmigrated_count BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'apps'
        AND column_name = 'user_database_status'
  )
    INTO legacy_columns_present;

  IF legacy_columns_present THEN
    EXECUTE $backfill$
      INSERT INTO "app_databases" (
        "app_id",
        "user_database_uri",
        "user_database_project_id",
        "user_database_branch_id",
        "user_database_region",
        "user_database_status",
        "user_database_error",
        "created_at",
        "updated_at"
      )
      SELECT
        "id",
        "user_database_uri",
        "user_database_project_id",
        "user_database_branch_id",
        "user_database_region",
        COALESCE("user_database_status", 'none'::"user_database_status"),
        "user_database_error",
        COALESCE("created_at", NOW()),
        COALESCE("updated_at", NOW())
      FROM "apps"
      WHERE COALESCE("user_database_status", 'none'::"user_database_status") <> 'none'::"user_database_status"
         OR "user_database_uri" IS NOT NULL
         OR "user_database_project_id" IS NOT NULL
         OR "user_database_branch_id" IS NOT NULL
         OR "user_database_error" IS NOT NULL
      ON CONFLICT ("app_id") DO UPDATE
      SET
        "user_database_uri" = EXCLUDED."user_database_uri",
        "user_database_project_id" = EXCLUDED."user_database_project_id",
        "user_database_branch_id" = EXCLUDED."user_database_branch_id",
        "user_database_region" = EXCLUDED."user_database_region",
        "user_database_status" = EXCLUDED."user_database_status",
        "user_database_error" = EXCLUDED."user_database_error",
        "updated_at" = NOW()
      WHERE "app_databases"."user_database_status" = 'none'::"user_database_status"
        AND "app_databases"."user_database_uri" IS NULL
        AND "app_databases"."user_database_project_id" IS NULL
        AND "app_databases"."user_database_branch_id" IS NULL
        AND "app_databases"."user_database_error" IS NULL
    $backfill$;

    EXECUTE $validate$
      SELECT COUNT(*)
      FROM "apps" a
      LEFT JOIN "app_databases" d ON d."app_id" = a."id"
      WHERE (
          COALESCE(a."user_database_status", 'none'::"user_database_status") <> 'none'::"user_database_status"
          OR a."user_database_uri" IS NOT NULL
          OR a."user_database_project_id" IS NOT NULL
          OR a."user_database_branch_id" IS NOT NULL
          OR a."user_database_error" IS NOT NULL
        )
        AND NOT (
          d."app_id" IS NOT NULL
          AND d."user_database_status" IS NOT DISTINCT FROM COALESCE(a."user_database_status", 'none'::"user_database_status")
          AND (a."user_database_uri" IS NULL OR d."user_database_uri" IS NOT DISTINCT FROM a."user_database_uri")
          AND (a."user_database_project_id" IS NULL OR d."user_database_project_id" IS NOT DISTINCT FROM a."user_database_project_id")
          AND (a."user_database_branch_id" IS NULL OR d."user_database_branch_id" IS NOT DISTINCT FROM a."user_database_branch_id")
          AND (a."user_database_region" IS NULL OR d."user_database_region" IS NOT DISTINCT FROM a."user_database_region")
          AND (a."user_database_error" IS NULL OR d."user_database_error" IS NOT DISTINCT FROM a."user_database_error")
        )
    $validate$
      INTO unmigrated_count;

    IF unmigrated_count > 0 THEN
      RAISE EXCEPTION
        'app_databases consolidation aborted: % apps rows still have legacy user_database data not represented in app_databases.',
        unmigrated_count;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS "apps_user_database_status_idx";

ALTER TABLE "apps"
  DROP COLUMN IF EXISTS "user_database_uri",
  DROP COLUMN IF EXISTS "user_database_project_id",
  DROP COLUMN IF EXISTS "user_database_branch_id",
  DROP COLUMN IF EXISTS "user_database_region",
  DROP COLUMN IF EXISTS "user_database_status",
  DROP COLUMN IF EXISTS "user_database_error";

COMMIT;

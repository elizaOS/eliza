-- Deploys apply ordered migrations before the runtime's idempotent schema
-- repair. Carry the backup-v2 columns here so a database created entirely from
-- migration history has the same contract before write-epoch SQL references it.
ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "snapshot_schema_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "state_data_descriptor" jsonb,
  ADD COLUMN IF NOT EXISTS "storage_commit_state" text NOT NULL DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS "storage_commit_error" text,
  ADD COLUMN IF NOT EXISTS "storage_commit_updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

-- Bind every schema-v2 object upload to one durable epoch before its first
-- remote side effect. Pre-epoch staging rows remain fail-closed because their
-- remote outcome cannot be reconstructed after a process crash.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backups"
    WHERE "snapshot_schema_version" = 2
      AND "state_data_storage" = 'chunked-v2'
      AND "storage_commit_state" <> 'complete'
      AND (
        "state_data_descriptor" IS NULL
        OR jsonb_typeof("state_data_descriptor") <> 'object'
        OR jsonb_typeof("state_data_descriptor" -> 'plannedObjectKeys') <> 'array'
      )
  ) THEN
    RAISE EXCEPTION
      'Schema-v2 incomplete backup rows require operator reconciliation before write-epoch migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backups"
    WHERE "snapshot_schema_version" = 2
      AND "state_data_storage" = 'chunked-v2'
      AND "storage_commit_state" <> 'complete'
      AND NOT ("state_data_descriptor" ? 'objectSetId')
      AND jsonb_array_length("state_data_descriptor" -> 'plannedObjectKeys') > 0
      AND (
        split_part(
          split_part("state_data_descriptor" -> 'plannedObjectKeys' ->> 0, '/', 4),
          '.',
          2
        ) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            "state_data_descriptor" -> 'plannedObjectKeys'
          ) WITH ORDINALITY AS planned("object_key", "position")
          WHERE split_part(planned."object_key", '/', 1) <> 'agent-sandbox-backups'
            OR split_part(planned."object_key", '/', 2)
              <> "state_data_descriptor" ->> 'organizationId'
            OR split_part(planned."object_key", '/', 3)
              !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            OR split_part(planned."object_key", '/', 4)
              <> "id"::text || '.' || split_part(
                split_part(
                  "state_data_descriptor" -> 'plannedObjectKeys' ->> 0,
                  '/',
                  4
                ),
                '.',
                2
              )
            OR split_part(planned."object_key", '/', 5)
              <> 'chunk-' || lpad((planned."position" - 1)::text, 6, '0') || '.bin'
            OR split_part(planned."object_key", '/', 6) <> ''
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Schema-v2 incomplete backup object-set identity cannot be reconstructed safely';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "agent_sandbox_backups"
SET
  "state_data_descriptor" =
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              "state_data_descriptor",
              '{objectSetId}',
              to_jsonb(
                CASE
                  WHEN jsonb_array_length("state_data_descriptor" -> 'plannedObjectKeys') = 0
                    THEN "id"::text
                  ELSE split_part(
                    split_part("state_data_descriptor" -> 'plannedObjectKeys' ->> 0, '/', 4),
                    '.',
                    2
                  )
                END
              ),
              true
            ),
            '{writeLeaseExpiresAt}',
            to_jsonb(
              to_char(
                "storage_commit_updated_at" AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ),
            true
          ),
          '{writeQuiescedAt}',
          'null'::jsonb,
          true
        ),
        '{commitState}',
        '"failed"'::jsonb,
        true
      ),
      '{failure}',
      '"Pre-write-epoch backup requires repeated exact-key reconciliation"'::jsonb,
      true
    ),
  "storage_commit_state" = 'failed',
  "storage_commit_error" =
    'Pre-write-epoch backup requires repeated exact-key reconciliation',
  "storage_commit_updated_at" = now()
WHERE "snapshot_schema_version" = 2
  AND "state_data_storage" = 'chunked-v2'
  AND "storage_commit_state" <> 'complete'
  AND NOT ("state_data_descriptor" ? 'objectSetId');
--> statement-breakpoint

-- Cleanup intents survive their source sandbox and backup rows, so legacy
-- intents need the same exact object-set identity as live backup rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backup_cleanup_intents"
    WHERE "descriptor" ->> 'commitState' IS DISTINCT FROM 'complete'
      AND (
        jsonb_typeof("descriptor") <> 'object'
        OR jsonb_typeof("descriptor" -> 'plannedObjectKeys') <> 'array'
        OR "descriptor" ->> 'organizationId' IS DISTINCT FROM "organization_id"::text
        OR "descriptor" ->> 'sandboxRecordId' IS DISTINCT FROM "sandbox_record_id"::text
        OR "descriptor" ->> 'backupId' IS DISTINCT FROM "backup_id"::text
      )
  ) THEN
    RAISE EXCEPTION
      'Schema-v2 incomplete backup cleanup intents require operator reconciliation before write-epoch migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backup_cleanup_intents"
    WHERE "descriptor" ->> 'commitState' IS DISTINCT FROM 'complete'
      AND NOT ("descriptor" ? 'objectSetId')
      AND jsonb_array_length("descriptor" -> 'plannedObjectKeys') > 0
      AND (
        split_part(
          split_part("descriptor" -> 'plannedObjectKeys' ->> 0, '/', 4),
          '.',
          2
        ) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            "descriptor" -> 'plannedObjectKeys'
          ) WITH ORDINALITY AS planned("object_key", "position")
          WHERE split_part(planned."object_key", '/', 1) <> 'agent-sandbox-backups'
            OR split_part(planned."object_key", '/', 2) <> "organization_id"::text
            OR split_part(planned."object_key", '/', 3)
              !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            OR split_part(planned."object_key", '/', 4)
              <> "backup_id"::text || '.' || split_part(
                split_part("descriptor" -> 'plannedObjectKeys' ->> 0, '/', 4),
                '.',
                2
              )
            OR split_part(planned."object_key", '/', 5)
              <> 'chunk-' || lpad((planned."position" - 1)::text, 6, '0') || '.bin'
            OR split_part(planned."object_key", '/', 6) <> ''
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Schema-v2 incomplete backup cleanup-intent object-set identity cannot be reconstructed safely';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "agent_sandbox_backup_cleanup_intents"
SET
  "descriptor" =
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              "descriptor",
              '{objectSetId}',
              to_jsonb(
                CASE
                  WHEN jsonb_array_length("descriptor" -> 'plannedObjectKeys') = 0
                    THEN "backup_id"::text
                  ELSE split_part(
                    split_part("descriptor" -> 'plannedObjectKeys' ->> 0, '/', 4),
                    '.',
                    2
                  )
                END
              ),
              true
            ),
            '{writeLeaseExpiresAt}',
            to_jsonb(
              to_char(
                "updated_at" AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              )
            ),
            true
          ),
          '{writeQuiescedAt}',
          'null'::jsonb,
          true
        ),
        '{commitState}',
        '"failed"'::jsonb,
        true
      ),
      '{failure}',
      '"Pre-write-epoch cleanup intent requires repeated exact-key reconciliation"'::jsonb,
      true
    ),
  "storage_commit_state" = 'failed',
  "updated_at" = now()
WHERE "descriptor" ->> 'commitState' IS DISTINCT FROM 'complete'
  AND NOT ("descriptor" ? 'objectSetId');
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backup_cleanup_intents"
    ADD CONSTRAINT "agent_sandbox_backup_cleanup_intents_write_epoch_check"
    CHECK (
      COALESCE(
        "descriptor" ->> 'commitState' = 'complete'
        OR (
        "storage_commit_state" = 'failed'
        AND jsonb_typeof("descriptor") = 'object'
        AND "descriptor" ->> 'format' = 'elizaos.agent-backup-chunks'
        AND "descriptor" ->> 'descriptorVersion' = '1'
        AND "descriptor" ->> 'backupSchemaVersion' = '2'
        AND jsonb_typeof("descriptor" -> 'organizationId') = 'string'
        AND jsonb_typeof("descriptor" -> 'sandboxRecordId') = 'string'
        AND jsonb_typeof("descriptor" -> 'backupId') = 'string'
        AND "descriptor" ->> 'organizationId' = "organization_id"::text
        AND "descriptor" ->> 'sandboxRecordId' = "sandbox_record_id"::text
        AND "descriptor" ->> 'backupId' = "backup_id"::text
        AND jsonb_typeof("descriptor" -> 'objectSetId') = 'string'
        AND (
          "descriptor" ->> 'objectSetId'
        ) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof("descriptor" -> 'writeLeaseExpiresAt') = 'string'
        AND (
          "descriptor" ->> 'writeLeaseExpiresAt'
        ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND "descriptor" ? 'writeQuiescedAt'
        AND jsonb_typeof("descriptor" -> 'plannedObjectKeys') = 'array'
        AND "descriptor" ->> 'commitState' = 'failed'
        AND jsonb_typeof("descriptor" -> 'failure') = 'string'
        AND (
          "descriptor" -> 'writeQuiescedAt' = 'null'::jsonb
          OR (
            jsonb_typeof("descriptor" -> 'writeQuiescedAt') = 'string'
            AND (
              "descriptor" ->> 'writeQuiescedAt'
            ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          )
        )
        ),
        FALSE
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_write_epoch_check"
    CHECK (
      NOT (
        "snapshot_schema_version" = 2
        AND "state_data_storage" = 'chunked-v2'
        AND "storage_commit_state" IN ('staging', 'failed')
      )
      OR COALESCE((
        jsonb_typeof("state_data_descriptor") = 'object'
        AND "state_data_descriptor" ->> 'format' = 'elizaos.agent-backup-chunks'
        AND "state_data_descriptor" ->> 'descriptorVersion' = '1'
        AND "state_data_descriptor" ->> 'backupSchemaVersion' = '2'
        AND jsonb_typeof("state_data_descriptor" -> 'backupId') = 'string'
        AND "state_data_descriptor" ->> 'backupId' = "id"::text
        AND jsonb_typeof("state_data_descriptor" -> 'objectSetId') = 'string'
        AND (
          "state_data_descriptor" ->> 'objectSetId'
        ) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof("state_data_descriptor" -> 'writeLeaseExpiresAt') = 'string'
        AND (
          "state_data_descriptor" ->> 'writeLeaseExpiresAt'
        ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND "state_data_descriptor" ? 'writeQuiescedAt'
        AND jsonb_typeof("state_data_descriptor" -> 'plannedObjectKeys') = 'array'
        AND (
          (
            "storage_commit_state" = 'staging'
            AND "state_data_descriptor" ->> 'commitState' = 'staging'
            AND "state_data_descriptor" -> 'writeQuiescedAt' = 'null'::jsonb
            AND "state_data_descriptor" -> 'failure' = 'null'::jsonb
          )
          OR (
            "storage_commit_state" = 'failed'
            AND "state_data_descriptor" ->> 'commitState' = 'failed'
            AND jsonb_typeof("state_data_descriptor" -> 'failure') = 'string'
            AND (
              "state_data_descriptor" -> 'writeQuiescedAt' = 'null'::jsonb
              OR (
                jsonb_typeof("state_data_descriptor" -> 'writeQuiescedAt') = 'string'
                AND (
                  "state_data_descriptor" ->> 'writeQuiescedAt'
                ) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
              )
            )
          )
        )
      ), FALSE)
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backups" backup
    WHERE backup."sandbox_record_id" = OLD."id"
      AND backup."snapshot_schema_version" = 2
      AND backup."state_data_storage" = 'chunked-v2'
      AND backup."storage_commit_state" <> 'complete'
      AND backup."state_data_descriptor" ->> 'commitState' IS DISTINCT FROM 'complete'
      AND (
        NOT (backup."state_data_descriptor" ? 'writeQuiescedAt')
        OR backup."state_data_descriptor" -> 'writeQuiescedAt' = 'null'::jsonb
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '55000',
        MESSAGE = 'Agent sandbox has an unquiesced backup write epoch';
  END IF;

  INSERT INTO "agent_sandbox_backup_cleanup_intents" (
    "backup_id",
    "organization_id",
    "sandbox_record_id",
    "descriptor",
    "storage_commit_state",
    "created_at",
    "updated_at"
  )
  SELECT
    backup."id",
    OLD."organization_id",
    backup."sandbox_record_id",
    backup."state_data_descriptor",
    backup."storage_commit_state",
    now(),
    now()
  FROM "agent_sandbox_backups" backup
  WHERE backup."sandbox_record_id" = OLD."id"
    AND backup."snapshot_schema_version" = 2
    AND backup."state_data_storage" = 'chunked-v2'
  ON CONFLICT ("backup_id") DO UPDATE SET
    "organization_id" = EXCLUDED."organization_id",
    "sandbox_record_id" = EXCLUDED."sandbox_record_id",
    "descriptor" = EXCLUDED."descriptor",
    "storage_commit_state" = EXCLUDED."storage_commit_state",
    "updated_at" = now();
  RETURN OLD;
END;
$$;

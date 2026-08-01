// Coordinates cloud DB ensure agent sandbox schema behavior shared by repositories and services.
import { sql } from "drizzle-orm";
import { getCloudAwareEnv } from "../lib/runtime/cloud-bindings";
import { applyDatabaseUrlFallback } from "./database-url";
import { dbWrite } from "./helpers";
import { WARM_POOL_ORG_ID } from "./schemas/agent-sandboxes";

const ensurePromises = new Map<string, Promise<void>>();

export async function ensureAgentSandboxBackupCleanupIntentSchema(): Promise<void> {
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_sandbox_backup_cleanup_intents" (
      "backup_id" uuid PRIMARY KEY,
      "organization_id" uuid NOT NULL,
      "sandbox_record_id" uuid NOT NULL,
      "descriptor" jsonb NOT NULL,
      "storage_commit_state" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backup_cleanup_intents_updated_idx"
      ON "agent_sandbox_backup_cleanup_intents" ("updated_at")
  `);
  await dbWrite.execute(sql`
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
    END $$
  `);
  await dbWrite.execute(sql`
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
      AND NOT ("descriptor" ? 'objectSetId')
  `);
  await dbWrite.execute(sql`
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
    END $$
  `);
  await dbWrite.execute(sql`
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
    $$
  `);
  await dbWrite.execute(sql`
    DO $$ BEGIN
      CREATE TRIGGER "agent_sandboxes_capture_backup_cleanup"
        BEFORE DELETE ON "agent_sandboxes"
        FOR EACH ROW
        EXECUTE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"();
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$
  `);
}

async function runEnsureAgentSandboxSchema(): Promise<void> {
  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandboxes"
      ADD COLUMN IF NOT EXISTS "pool_status" text,
      ADD COLUMN IF NOT EXISTS "pool_ready_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "environment_revision" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "lifecycle_revision" bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "deletion_attempt_id" uuid,
      ADD COLUMN IF NOT EXISTS "deletion_started_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "warm_claim_credential_state" text,
      ADD COLUMN IF NOT EXISTS "warm_claim_source_pool_id" uuid,
      ADD COLUMN IF NOT EXISTS "warm_claim_key_fingerprint" text,
      ADD COLUMN IF NOT EXISTS "warm_claim_attested_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "warm_claim_attested_environment_revision" integer,
      ADD COLUMN IF NOT EXISTS "warm_claim_cleanup_completed_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_sandbox_id" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_id" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_container_name" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_attempt_id" uuid,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_container_id" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_node_id" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_node_name" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_preserved_vpn_node_id" text,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_registration_started_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_allocation_counted" boolean,
      ADD COLUMN IF NOT EXISTS "replacement_cleanup_created_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "previous_image_digest" text,
      ADD COLUMN IF NOT EXISTS "previous_docker_image" text
  `);

  await dbWrite.execute(sql`
    CREATE OR REPLACE FUNCTION advance_agent_sandbox_lifecycle_revision()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
      RETURN NEW;
    END;
    $$
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
      BEFORE UPDATE ON "agent_sandboxes"
      FOR EACH ROW
      EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandboxes"
        ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_locator_check"
        CHECK (
        (
          "replacement_cleanup_sandbox_id" IS NULL
          AND "replacement_cleanup_node_id" IS NULL
          AND "replacement_cleanup_container_name" IS NULL
          AND "replacement_cleanup_attempt_id" IS NULL
          AND "replacement_cleanup_container_id" IS NULL
          AND "replacement_cleanup_vpn_node_id" IS NULL
          AND "replacement_cleanup_vpn_node_name" IS NULL
          AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
          AND "replacement_cleanup_vpn_registration_started_at" IS NULL
          AND "replacement_cleanup_allocation_counted" IS NULL
          AND "replacement_cleanup_created_at" IS NULL
        )
        OR (
          "replacement_cleanup_sandbox_id" IS NOT NULL
          AND "replacement_cleanup_node_id" IS NOT NULL
          AND "replacement_cleanup_container_name" IS NOT NULL
          AND "replacement_cleanup_allocation_counted" IS NOT NULL
          AND "replacement_cleanup_created_at" IS NOT NULL
          AND (
            (
              "replacement_cleanup_attempt_id" IS NOT NULL
              AND (
                (
                  "replacement_cleanup_vpn_node_id" IS NULL
                  AND
                  "replacement_cleanup_vpn_node_name" IS NULL
                  AND "replacement_cleanup_vpn_registration_started_at" IS NULL
                  AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
                )
                OR (
                  "replacement_cleanup_vpn_node_name" IS NOT NULL
                  AND "replacement_cleanup_vpn_registration_started_at" IS NOT NULL
                )
              )
            )
            OR (
              "replacement_cleanup_attempt_id" IS NULL
              AND "replacement_cleanup_container_id" IS NULL
              AND "replacement_cleanup_vpn_node_name" IS NULL
              AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
              AND "replacement_cleanup_vpn_registration_started_at" IS NULL
              AND "replacement_cleanup_allocation_counted" = TRUE
            )
          )
        )
        );
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandboxes"
        ADD CONSTRAINT "agent_sandboxes_warm_claim_credential_state_check"
        CHECK (
          "warm_claim_credential_state" IS NULL
          OR "warm_claim_credential_state" IN ('pending', 'attested', 'ready', 'failed')
        );
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandboxes"
        ADD CONSTRAINT "agent_sandboxes_deletion_intent_pair_check"
        CHECK (
          (
            "deletion_attempt_id" IS NULL
            AND "deletion_started_at" IS NULL
          )
          OR (
            "deletion_attempt_id" IS NOT NULL
            AND "deletion_started_at" IS NOT NULL
          )
        );
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_warm_claim_pending_idx"
      ON "agent_sandboxes" ("updated_at")
      WHERE "claimed_at" IS NOT NULL
        AND "warm_claim_credential_state" IS DISTINCT FROM 'ready'
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_warm_claim_cleanup_idx"
      ON "agent_sandboxes" ("updated_at")
      WHERE "warm_claim_credential_state" = 'failed'
        AND "warm_claim_cleanup_completed_at" IS NULL
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_container_name_idx"
      ON "agent_sandboxes" ("container_name")
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_replacement_cleanup_container_name_idx"
      ON "agent_sandboxes" ("replacement_cleanup_container_name")
      WHERE "replacement_cleanup_container_name" IS NOT NULL
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_replacement_cleanup_pending_idx"
      ON "agent_sandboxes" ("replacement_cleanup_created_at")
      WHERE "replacement_cleanup_sandbox_id" IS NOT NULL
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandboxes_pool_unclaimed_idx"
      ON "agent_sandboxes" ("pool_ready_at" ASC NULLS LAST)
      WHERE "pool_status" = 'unclaimed'
  `);

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_sandbox_backups" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "sandbox_record_id" uuid NOT NULL REFERENCES "agent_sandboxes"("id") ON DELETE CASCADE,
      "snapshot_type" text NOT NULL,
      "state_data" jsonb NOT NULL,
      "snapshot_schema_version" integer NOT NULL DEFAULT 1,
      "state_data_storage" text NOT NULL DEFAULT 'inline',
      "state_data_key" text,
      "state_data_descriptor" jsonb,
      "storage_commit_state" text NOT NULL DEFAULT 'complete',
      "storage_commit_error" text,
      "storage_commit_updated_at" timestamptz NOT NULL DEFAULT now(),
      "size_bytes" bigint,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandbox_backups"
      ADD COLUMN IF NOT EXISTS "snapshot_schema_version" integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "state_data_storage" text NOT NULL DEFAULT 'inline',
      ADD COLUMN IF NOT EXISTS "state_data_key" text,
      ADD COLUMN IF NOT EXISTS "state_data_descriptor" jsonb,
      ADD COLUMN IF NOT EXISTS "storage_commit_state" text NOT NULL DEFAULT 'complete',
      ADD COLUMN IF NOT EXISTS "storage_commit_error" text,
      ADD COLUMN IF NOT EXISTS "storage_commit_updated_at" timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS "size_bytes" bigint,
      ADD COLUMN IF NOT EXISTS "backup_kind" text NOT NULL DEFAULT 'full',
      ADD COLUMN IF NOT EXISTS "parent_backup_id" uuid,
      ADD COLUMN IF NOT EXISTS "content_hash" text,
      ADD COLUMN IF NOT EXISTS "verification_status" text,
      ADD COLUMN IF NOT EXISTS "verified_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "verification_error" text
  `);

  await dbWrite.execute(sql`
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
              WHERE split_part(planned."object_key", '/', 1)
                  <> 'agent-sandbox-backups'
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
    END $$
  `);

  await dbWrite.execute(sql`
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
                        split_part(
                          "state_data_descriptor" -> 'plannedObjectKeys' ->> 0,
                          '/',
                          4
                        ),
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
      AND NOT ("state_data_descriptor" ? 'objectSetId')
  `);

  await dbWrite.execute(sql`
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
    END $$
  `);

  await ensureAgentSandboxBackupCleanupIntentSchema();

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_parent_idx"
      ON "agent_sandbox_backups" ("parent_backup_id")
  `);

  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandbox_backups"
      DROP COLUMN IF EXISTS "vercel_snapshot_id"
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_sandbox_idx"
      ON "agent_sandbox_backups" ("sandbox_record_id")
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_created_at_idx"
      ON "agent_sandbox_backups" ("created_at")
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_sandbox_latest_idx"
      ON "agent_sandbox_backups" ("sandbox_record_id", "created_at" DESC)
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_storage_reconcile_idx"
      ON "agent_sandbox_backups" ("storage_commit_updated_at")
      WHERE "storage_commit_state" <> 'complete'
  `);

  await dbWrite.execute(sql`
    INSERT INTO "organizations" ("id", "name", "slug", "credit_balance", "is_active")
    VALUES (
      ${WARM_POOL_ORG_ID},
      'Warm Pool (system)',
      '__warm_pool__',
      0,
      false
    )
    ON CONFLICT DO NOTHING
  `);

  await dbWrite.execute(sql`
    DO $$
    DECLARE
      has_steward_user_id boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'steward_user_id'
      ) INTO has_steward_user_id;

      IF has_steward_user_id THEN
        EXECUTE 'INSERT INTO "users" ("id", "name", "organization_id", "role", "wallet_verified", "is_active", "steward_user_id")
                 VALUES (''00000000-0000-4000-8000-000000077002'', ''Warm Pool (system)'', ''00000000-0000-4000-8000-000000077001'', ''system'', false, false, ''system:warm-pool'')
                 ON CONFLICT DO NOTHING';
      ELSE
        EXECUTE 'INSERT INTO "users" ("id", "name", "organization_id", "role", "wallet_verified", "is_active")
                 VALUES (''00000000-0000-4000-8000-000000077002'', ''Warm Pool (system)'', ''00000000-0000-4000-8000-000000077001'', ''system'', false, false)
                 ON CONFLICT DO NOTHING';
      END IF;
    END $$;
  `);

  await dbWrite.execute(sql`
    DO $$
    BEGIN
      IF to_regclass('public.eliza_pairing_tokens') IS NOT NULL
        AND to_regclass('public.agent_pairing_tokens') IS NULL THEN
        ALTER TABLE "eliza_pairing_tokens" RENAME TO "agent_pairing_tokens";
      END IF;
    END $$;
  `);

  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS "agent_pairing_tokens" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "token_hash" text NOT NULL,
      "organization_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "agent_id" uuid NOT NULL,
      "instance_url" text NOT NULL,
      "expected_origin" text NOT NULL,
      "expires_at" timestamp with time zone NOT NULL,
      "used_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);

  await dbWrite.execute(sql`
    ALTER TABLE "agent_pairing_tokens"
      ADD COLUMN IF NOT EXISTS "token_hash" text,
      ADD COLUMN IF NOT EXISTS "organization_id" uuid,
      ADD COLUMN IF NOT EXISTS "user_id" uuid,
      ADD COLUMN IF NOT EXISTS "agent_id" uuid,
      ADD COLUMN IF NOT EXISTS "instance_url" text,
      ADD COLUMN IF NOT EXISTS "expected_origin" text,
      ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL
  `);

  await dbWrite.execute(sql`
    DO $$
    DECLARE
      fk record;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'eliza_pairing_tokens_token_hash_unique'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'agent_pairing_tokens_token_hash_unique'
      ) THEN
        ALTER TABLE "agent_pairing_tokens"
          RENAME CONSTRAINT "eliza_pairing_tokens_token_hash_unique"
          TO "agent_pairing_tokens_token_hash_unique";
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'agent_pairing_tokens_token_hash_unique'
      ) THEN
        ALTER TABLE "agent_pairing_tokens"
          ADD CONSTRAINT "agent_pairing_tokens_token_hash_unique" UNIQUE ("token_hash");
      END IF;

      FOR fk IN
        SELECT * FROM (VALUES
          ('eliza_pairing_tokens_organization_id_fkey', 'agent_pairing_tokens_organization_id_fkey'),
          ('eliza_pairing_tokens_user_id_fkey', 'agent_pairing_tokens_user_id_fkey'),
          ('eliza_pairing_tokens_agent_id_fkey', 'agent_pairing_tokens_agent_id_fkey')
        ) AS names(old_name, new_name)
      LOOP
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.agent_pairing_tokens'::regclass
            AND conname = fk.old_name
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.agent_pairing_tokens'::regclass
            AND conname = fk.new_name
        ) THEN
          EXECUTE format(
            'ALTER TABLE "agent_pairing_tokens" RENAME CONSTRAINT %I TO %I',
            fk.old_name,
            fk.new_name
          );
        END IF;
      END LOOP;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'agent_pairing_tokens_organization_id_fkey'
      ) THEN
        ALTER TABLE "agent_pairing_tokens"
          ADD CONSTRAINT "agent_pairing_tokens_organization_id_fkey"
          FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'agent_pairing_tokens_user_id_fkey'
      ) THEN
        ALTER TABLE "agent_pairing_tokens"
          ADD CONSTRAINT "agent_pairing_tokens_user_id_fkey"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_pairing_tokens'::regclass
          AND conname = 'agent_pairing_tokens_agent_id_fkey'
      ) THEN
        ALTER TABLE "agent_pairing_tokens"
          ADD CONSTRAINT "agent_pairing_tokens_agent_id_fkey"
          FOREIGN KEY ("agent_id") REFERENCES "agent_sandboxes"("id") ON DELETE cascade;
      END IF;
    END $$;
  `);

  await dbWrite.execute(sql`
    DO $$
    DECLARE
      rename_index record;
    BEGIN
      FOR rename_index IN
        SELECT * FROM (VALUES
          ('eliza_pairing_tokens_token_hash_idx', 'agent_pairing_tokens_token_hash_idx'),
          ('eliza_pairing_tokens_expires_at_idx', 'agent_pairing_tokens_expires_at_idx'),
          ('eliza_pairing_tokens_agent_id_idx', 'agent_pairing_tokens_agent_id_idx')
        ) AS index_names(old_name, new_name)
      LOOP
        IF to_regclass(format('public.%I', rename_index.old_name)) IS NOT NULL
          AND to_regclass(format('public.%I', rename_index.new_name)) IS NULL THEN
          EXECUTE format(
            'ALTER INDEX public.%I RENAME TO %I',
            rename_index.old_name,
            rename_index.new_name
          );
        END IF;
      END LOOP;
    END $$;
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_token_hash_idx"
      ON "agent_pairing_tokens" ("token_hash")
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_expires_at_idx"
      ON "agent_pairing_tokens" ("expires_at")
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_pairing_tokens_agent_id_idx"
      ON "agent_pairing_tokens" ("agent_id")
  `);
}

/**
 * Production has had migrations applied out of order during CF cutover. Keep
 * this idempotent guard until all live databases have converged on migration
 * 0115 or later.
 *
 * Local dev / tests always run `db:migrate` on boot, so the guard is dead
 * weight there — worse, it issues ~15 sequential ALTER/CREATE statements
 * per request, each opening a fresh TCP connection (Worker pool config sets
 * `maxUses: 1`), which the PGlite socket bridge intermittently drops with
 * "Connection terminated unexpectedly". Short-circuit when:
 *   - ENVIRONMENT === "local" (the dev script sets this), or
 *   - SKIP_AGENT_SANDBOX_ENSURE === "1" (escape hatch for tests/CI).
 */
function shouldSkipEnsure(): boolean {
  const env = getCloudAwareEnv();
  if (env.SKIP_AGENT_SANDBOX_ENSURE === "1") return true;
  if (env.ENVIRONMENT === "local") return true;
  return false;
}

export async function ensureAgentSandboxSchema(): Promise<void> {
  if (shouldSkipEnsure()) return;
  const key = applyDatabaseUrlFallback(getCloudAwareEnv()) ?? "__missing_database_url__";
  let promise = ensurePromises.get(key);
  if (!promise) {
    promise = runEnsureAgentSandboxSchema().catch((error) => {
      ensurePromises.delete(key);
      throw error;
    });
    ensurePromises.set(key, promise);
  }

  return promise;
}

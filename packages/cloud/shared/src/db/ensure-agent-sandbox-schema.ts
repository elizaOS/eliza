// Coordinates cloud DB ensure agent sandbox schema behavior shared by repositories and services.
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { isCloudflareWorkerRuntime } from "../lib/cache/redis-factory";
import { getCloudAwareEnv } from "../lib/runtime/cloud-bindings";
import { applyDatabaseUrlFallback } from "./database-url";
import { dbWrite as defaultDbWrite } from "./helpers";
import { WARM_POOL_ORG_ID } from "./schemas/agent-sandboxes";

const ensurePromises = new Map<string, Promise<void>>();

export interface AgentSandboxSchemaExecutor {
  execute(statement: SQL): Promise<unknown>;
}

/**
 * Runs one already-rendered, parameterized statement on a raw session. The
 * deploy-time migration runner supplies its locked `pg`/PGlite `query(text,
 * params)` here; `drizzle-orm` rendering stays inside this owning workspace so
 * the scripts entrypoint never imports `drizzle-orm/pg-core` across an invalid
 * package boundary (issue #22606).
 */
export type RawSqlQuery = (text: string, params: unknown[]) => Promise<unknown>;

/**
 * Builds an executor that renders each Drizzle `SQL` convergence statement into
 * a `{ sql, params }` pair with `PgDialect` and forwards it to the supplied raw
 * parameterized query function, preserving statement order. Keeping the
 * `PgDialect` dependency here lets the filtered Cloud `scripts/admin` install
 * consume convergence without depending on `drizzle-orm` directly.
 */
export function createMigrationClientSandboxExecutor(
  query: RawSqlQuery,
): AgentSandboxSchemaExecutor {
  const dialect = new PgDialect();
  return {
    execute: (statement: SQL) => {
      const rendered = dialect.sqlToQuery(statement);
      return query(rendered.sql, rendered.params);
    },
  };
}

/**
 * Runs the idempotent repair batch through the supplied database session.
 * Deploy-time migration uses its locked session; runtime callers use the
 * shared write connection only outside workerd.
 */
export async function convergeAgentSandboxSchema(
  dbWrite: AgentSandboxSchemaExecutor = defaultDbWrite,
): Promise<void> {
  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandboxes"
      ADD COLUMN IF NOT EXISTS "pool_status" text,
      ADD COLUMN IF NOT EXISTS "pool_ready_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "environment_revision" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "lifecycle_revision" bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "deletion_attempt_id" uuid,
      ADD COLUMN IF NOT EXISTS "deletion_started_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "deletion_previous_status" text,
      ADD COLUMN IF NOT EXISTS "deletion_previous_billing_status" text,
      ADD COLUMN IF NOT EXISTS "deletion_previous_shutdown_warning_sent_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "deletion_previous_scheduled_shutdown_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "deletion_allocation_counted" boolean,
      ADD COLUMN IF NOT EXISTS "pre_delete_capture_waiver_attempt_id" uuid,
      ADD COLUMN IF NOT EXISTS "pre_delete_capture_waiver_environment_revision" integer,
      ADD COLUMN IF NOT EXISTS "pre_delete_capture_waiver_sandbox_id" text,
      ADD COLUMN IF NOT EXISTS "pre_delete_capture_waiver_bridge_url" text,
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
      ADD COLUMN IF NOT EXISTS "previous_docker_image" text,
      ADD COLUMN IF NOT EXISTS "last_backup_attempt_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "backup_unsupported_reason" text
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandboxes"
        ADD CONSTRAINT "agent_sandboxes_pre_delete_capture_waiver_shape_check"
        CHECK ((
          "pre_delete_capture_waiver_attempt_id" IS NULL
          AND "pre_delete_capture_waiver_environment_revision" IS NULL
          AND "pre_delete_capture_waiver_sandbox_id" IS NULL
          AND "pre_delete_capture_waiver_bridge_url" IS NULL
        ) OR (
          "pre_delete_capture_waiver_attempt_id" IS NOT NULL
          AND "pre_delete_capture_waiver_attempt_id" = "deletion_attempt_id"
          AND "pre_delete_capture_waiver_environment_revision" = "environment_revision"
          AND "pre_delete_capture_waiver_sandbox_id" IS NOT DISTINCT FROM "sandbox_id"
          AND "pre_delete_capture_waiver_bridge_url" IS NOT NULL
        ));
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$;
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
      "sandbox_record_id" uuid REFERENCES "agent_sandboxes"("id") ON DELETE CASCADE,
      "snapshot_type" text NOT NULL,
      "state_data" jsonb NOT NULL,
      "state_data_storage" text NOT NULL DEFAULT 'inline',
      "state_data_key" text,
      "size_bytes" bigint,
      "recovery_organization_id" uuid REFERENCES "organizations"("id") ON DELETE CASCADE,
      "recovery_agent_id" uuid,
      "recovery_deletion_attempt_id" uuid,
      "recovery_expires_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandbox_backups"
      ADD COLUMN IF NOT EXISTS "state_data_storage" text NOT NULL DEFAULT 'inline',
      ADD COLUMN IF NOT EXISTS "state_data_key" text,
      ADD COLUMN IF NOT EXISTS "size_bytes" bigint,
      ADD COLUMN IF NOT EXISTS "backup_kind" text NOT NULL DEFAULT 'full',
      ADD COLUMN IF NOT EXISTS "parent_backup_id" uuid,
      ADD COLUMN IF NOT EXISTS "content_hash" text,
      ADD COLUMN IF NOT EXISTS "verification_status" text,
      ADD COLUMN IF NOT EXISTS "verified_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "verification_error" text,
      ADD COLUMN IF NOT EXISTS "recovery_organization_id" uuid,
      ADD COLUMN IF NOT EXISTS "recovery_agent_id" uuid,
      ADD COLUMN IF NOT EXISTS "recovery_deletion_attempt_id" uuid,
      ADD COLUMN IF NOT EXISTS "recovery_expires_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "catalog_state" text,
      ALTER COLUMN "sandbox_record_id" DROP NOT NULL
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandbox_backups"
        ADD CONSTRAINT "agent_sandbox_backups_recovery_organization_id_fkey"
        FOREIGN KEY ("recovery_organization_id")
        REFERENCES "organizations"("id") ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$
  `);

  await dbWrite.execute(sql`
    DO $$ BEGIN
      ALTER TABLE "agent_sandbox_backups"
        ADD CONSTRAINT "agent_sandbox_backups_recovery_shape_check"
        CHECK ((
          "sandbox_record_id" IS NOT NULL
          AND "recovery_organization_id" IS NULL
          AND "recovery_agent_id" IS NULL
          AND "recovery_deletion_attempt_id" IS NULL
          AND "recovery_expires_at" IS NULL
        ) OR (
          "sandbox_record_id" IS NULL
          AND "snapshot_type" = 'pre-delete'
          AND "backup_kind" = 'full'
          AND "parent_backup_id" IS NULL
          AND "recovery_organization_id" IS NOT NULL
          AND "recovery_agent_id" IS NOT NULL
          AND "recovery_deletion_attempt_id" IS NOT NULL
          AND "recovery_expires_at" IS NOT NULL
        ));
    EXCEPTION
      WHEN duplicate_object THEN null;
    END $$
  `);

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
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_lookup_idx"
      ON "agent_sandbox_backups"
      ("recovery_organization_id", "recovery_agent_id", "created_at" DESC)
      WHERE "sandbox_record_id" IS NULL
  `);

  await dbWrite.execute(sql`
    CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_expires_idx"
      ON "agent_sandbox_backups" ("recovery_expires_at")
      WHERE "sandbox_record_id" IS NULL
  `);

  await dbWrite.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_backups_recovery_attempt_uidx"
      ON "agent_sandbox_backups"
      ("recovery_organization_id", "recovery_agent_id", "recovery_deletion_attempt_id")
      WHERE "sandbox_record_id" IS NULL
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
 * weight there. Its large sequential ALTER/CREATE batch is also unsuitable
 * for a request or waitUntil execution budget. Short-circuit when:
 *   - ENVIRONMENT === "local" (the dev script sets this), or
 *   - SKIP_AGENT_SANDBOX_ENSURE === "1" (escape hatch for tests/CI).
 */
export function shouldSkipEnsure(): boolean {
  const env = getCloudAwareEnv();
  if (env.ENVIRONMENT === "local") return true;
  // workerd: this guard issues a large sequential DDL/DO batch inside whatever
  // request (or waitUntil budget) happened to touch an agent-sandboxes
  // repository first. It cannot reliably finish there: observed live on staging
  // (2026-08-19) as EVERY cold shared-agent scope hydration failing with the
  // guard's own "Failed query: ALTER TABLE agent_sandboxes ..." — which kept
  // the scope cache permanently cold and turned the retryable first-turn
  // warming 503 into a recurring per-conversation stall. Schema convergence
  // belongs to environments that can run it to completion (Node daemons,
  // deploy-time db:migrate); a Worker that needs it can opt in explicitly.
  if (isCloudflareWorkerRuntime()) {
    return env.AGENT_SANDBOX_ENSURE_IN_WORKER !== "1";
  }
  return env.SKIP_AGENT_SANDBOX_ENSURE === "1";
}

export async function ensureAgentSandboxSchema(): Promise<void> {
  if (shouldSkipEnsure()) return;
  const key = applyDatabaseUrlFallback(getCloudAwareEnv()) ?? "__missing_database_url__";
  let promise = ensurePromises.get(key);
  if (!promise) {
    promise = convergeAgentSandboxSchema().catch((error) => {
      ensurePromises.delete(key);
      throw error;
    });
    ensurePromises.set(key, promise);
  }

  return promise;
}

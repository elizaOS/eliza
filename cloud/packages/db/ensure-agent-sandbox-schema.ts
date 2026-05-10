import { sql } from "drizzle-orm";
import { applyDatabaseUrlFallback } from "@/db/database-url";
import { dbWrite } from "@/db/helpers";
import { WARM_POOL_ORG_ID } from "@/db/schemas/agent-sandboxes";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

const ensurePromises = new Map<string, Promise<void>>();

async function runEnsureAgentSandboxSchema(): Promise<void> {
  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandboxes"
      ADD COLUMN IF NOT EXISTS "pool_status" text,
      ADD COLUMN IF NOT EXISTS "pool_ready_at" timestamptz,
      ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz
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
      "state_data_storage" text NOT NULL DEFAULT 'inline',
      "state_data_key" text,
      "size_bytes" bigint,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);

  await dbWrite.execute(sql`
    ALTER TABLE "agent_sandbox_backups"
      ADD COLUMN IF NOT EXISTS "state_data_storage" text NOT NULL DEFAULT 'inline',
      ADD COLUMN IF NOT EXISTS "state_data_key" text,
      ADD COLUMN IF NOT EXISTS "size_bytes" bigint
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
 */
export async function ensureAgentSandboxSchema(): Promise<void> {
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

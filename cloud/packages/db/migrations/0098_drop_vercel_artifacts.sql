-- Drop schema artifacts left behind by the Vercel removal.
--
-- Vercel deployment, sandbox, and domains integrations were removed in favor
-- of Cloudflare Workers + Docker. This migration drops:
--   1. Vercel-specific columns/indexes on still-live tables
--   2. The orphaned App Builder tables (whole subsystem deleted)
--
-- All targets are nullable columns or unreferenced tables. Safe to apply on
-- live data — no backfill required.

-- 1. app_domains: drop Vercel project/domain bindings + their index.
DROP INDEX IF EXISTS "app_domains_vercel_domain_idx";
ALTER TABLE "app_domains" DROP COLUMN IF EXISTS "vercel_project_id";
ALTER TABLE "app_domains" DROP COLUMN IF EXISTS "vercel_domain_id";

-- 2. agent_sandbox_backups: drop Vercel snapshot id.
ALTER TABLE IF EXISTS "agent_sandbox_backups" DROP COLUMN IF EXISTS "vercel_snapshot_id";

-- 3. managed_domains: drop Vercel domain id.
ALTER TABLE "managed_domains" DROP COLUMN IF EXISTS "vercel_domain_id";

-- 4. App Builder tables — entire subsystem deleted (Vercel-Sandbox-coupled).
DROP TABLE IF EXISTS "session_restore_history";
DROP TABLE IF EXISTS "session_file_snapshots";
DROP TABLE IF EXISTS "app_builder_prompts";
DROP TABLE IF EXISTS "app_sandbox_sessions";
DROP TABLE IF EXISTS "app_templates";
DROP TABLE IF EXISTS "sandbox_template_snapshots";

-- 5. managed_domains: drop "vercel" from registrar + nameserver_mode enums.
-- Postgres can't remove enum values directly; rename the type, create a new
-- one without "vercel", swap the column over, and drop the old type. Preserve
-- every non-vercel value already present so branch/test databases with newer
-- registrar providers do not fail or lose provider state.

-- Backfill any rows still on the legacy default before swapping types.
UPDATE "managed_domains" SET "registrar" = 'external' WHERE "registrar"::text = 'vercel';
UPDATE "managed_domains" SET "nameserver_mode" = 'external' WHERE "nameserver_mode"::text = 'vercel';

-- domain_registrar
ALTER TYPE "domain_registrar" RENAME TO "domain_registrar_old";
DO $$
DECLARE
  labels text;
BEGIN
  SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder)
    INTO labels
  FROM pg_enum
  WHERE enumtypid = 'domain_registrar_old'::regtype
    AND enumlabel <> 'vercel';

  EXECUTE format('CREATE TYPE "domain_registrar" AS ENUM (%s)', labels);
END $$;
ALTER TABLE "managed_domains" ALTER COLUMN "registrar" DROP DEFAULT;
ALTER TABLE "managed_domains"
  ALTER COLUMN "registrar" TYPE "domain_registrar"
  USING "registrar"::text::"domain_registrar";
ALTER TABLE "managed_domains" ALTER COLUMN "registrar" SET DEFAULT 'external';
DROP TYPE "domain_registrar_old";

-- domain_nameserver_mode
ALTER TYPE "domain_nameserver_mode" RENAME TO "domain_nameserver_mode_old";
DO $$
DECLARE
  labels text;
BEGIN
  SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder)
    INTO labels
  FROM pg_enum
  WHERE enumtypid = 'domain_nameserver_mode_old'::regtype
    AND enumlabel <> 'vercel';

  EXECUTE format('CREATE TYPE "domain_nameserver_mode" AS ENUM (%s)', labels);
END $$;
ALTER TABLE "managed_domains" ALTER COLUMN "nameserver_mode" DROP DEFAULT;
ALTER TABLE "managed_domains"
  ALTER COLUMN "nameserver_mode" TYPE "domain_nameserver_mode"
  USING "nameserver_mode"::text::"domain_nameserver_mode";
ALTER TABLE "managed_domains" ALTER COLUMN "nameserver_mode" SET DEFAULT 'external';
DROP TYPE "domain_nameserver_mode_old";

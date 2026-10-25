-- Drop dead Neon teardown columns. Provisioning moved from Neon to Railway;
-- current code never writes these columns non-null, so they are dead. The Neon
-- teardown surface that read them has been removed. Guarded drops keep this
-- idempotent across already-migrated and pre-cutover databases.
ALTER TABLE "agent_sandboxes" DROP COLUMN IF EXISTS "neon_project_id";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" DROP COLUMN IF EXISTS "neon_branch_id";
--> statement-breakpoint
ALTER TABLE "app_databases" DROP COLUMN IF EXISTS "user_database_project_id";
--> statement-breakpoint
ALTER TABLE "app_databases" DROP COLUMN IF EXISTS "user_database_branch_id";

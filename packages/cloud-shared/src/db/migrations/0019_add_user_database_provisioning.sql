-- Migration: Add user database provisioning fields to apps table
-- Enables stateful apps to have their own Neon serverless Postgres database

-- Create the user database status enum
DO $$ BEGIN
    CREATE TYPE "public"."user_database_status" AS ENUM('none', 'provisioning', 'ready', 'error');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Add user database columns to apps table
ALTER TABLE "apps"
ADD COLUMN IF NOT EXISTS "user_database_uri" text,
ADD COLUMN IF NOT EXISTS "user_database_project_id" text,
ADD COLUMN IF NOT EXISTS "user_database_branch_id" text,
ADD COLUMN IF NOT EXISTS "user_database_region" text DEFAULT 'aws-us-east-1',
ADD COLUMN IF NOT EXISTS "user_database_status" "user_database_status" DEFAULT 'none' NOT NULL,
ADD COLUMN IF NOT EXISTS "user_database_error" text;
--> statement-breakpoint

-- Add index for querying apps with databases (useful for admin/billing queries)
CREATE INDEX IF NOT EXISTS "apps_user_database_status_idx" ON "apps"("user_database_status");
--> statement-breakpoint

-- Comments for documentation
COMMENT ON COLUMN apps.user_database_uri IS 'Encrypted connection URI to the users provisioned Neon database';
COMMENT ON COLUMN apps.user_database_project_id IS 'Neon project ID for API operations (format: proj_xxxxxxxxxxxx)';
COMMENT ON COLUMN apps.user_database_branch_id IS 'Neon branch ID - primary branch created with project (format: br_xxxxxxxxxxxx)';
COMMENT ON COLUMN apps.user_database_region IS 'AWS region where the database is provisioned';
COMMENT ON COLUMN apps.user_database_status IS 'Provisioning status: none → provisioning → ready | error';
COMMENT ON COLUMN apps.user_database_error IS 'Error message if provisioning failed, cleared when retrying';

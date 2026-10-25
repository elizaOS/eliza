-- Add missing columns to apps table that were in the schema but never migrated
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "github_repo" text;
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "promotional_assets" jsonb DEFAULT '[]'::jsonb;

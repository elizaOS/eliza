-- Add deployment_status enum and columns to apps table
-- Tracks the deployment lifecycle of apps (draft, building, deploying, deployed, failed)

-- Create the deployment status enum
DO $$ BEGIN
    CREATE TYPE "public"."app_deployment_status" AS ENUM('draft', 'building', 'deploying', 'deployed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Add deployment_status column with default 'draft'
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "deployment_status" "app_deployment_status" DEFAULT 'draft' NOT NULL;
--> statement-breakpoint

-- Add production_url column (only set after successful deployment)
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "production_url" text;
--> statement-breakpoint

-- Add last_deployed_at timestamp
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "last_deployed_at" timestamp;
--> statement-breakpoint

-- Set existing active apps to 'deployed' status if they have a valid app_url
UPDATE "apps" SET "deployment_status" = 'deployed', "production_url" = "app_url" WHERE "is_active" = true AND "app_url" IS NOT NULL AND "app_url" != '';

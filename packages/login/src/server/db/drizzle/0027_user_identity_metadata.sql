ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_tenants" ADD COLUMN IF NOT EXISTS "custom_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;

-- Migration: Add Discord identity columns to users table
-- Supports Discord authentication for Eliza App
-- Custom migration following docs/database-migrations.md guidelines

-- Add Discord identity columns (uses IF NOT EXISTS for idempotency)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_global_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_avatar_url" text;--> statement-breakpoint

-- Add unique constraint on discord_id (idempotent - checks if exists first)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_discord_id_unique'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_discord_id_unique" UNIQUE ("discord_id");
  END IF;
END $$;--> statement-breakpoint

-- Create partial index for efficient lookups (only indexes non-null values)
CREATE INDEX IF NOT EXISTS "users_discord_id_idx" ON "users" ("discord_id") WHERE "discord_id" IS NOT NULL;

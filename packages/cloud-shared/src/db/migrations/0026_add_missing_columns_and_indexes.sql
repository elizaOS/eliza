-- Add missing columns to app_sandbox_sessions
-- These were in the schema but got lost during migration consolidation
ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "git_branch" text DEFAULT 'main' NOT NULL;
ALTER TABLE "app_sandbox_sessions" ADD COLUMN IF NOT EXISTS "last_commit_sha" text;

-- Add missing performance indexes for foreign key columns
-- Important for CASCADE delete performance
CREATE INDEX IF NOT EXISTS "idx_logs_room_id" ON "logs" ("room_id");
CREATE INDEX IF NOT EXISTS "idx_components_room_id" ON "components" ("room_id");
CREATE INDEX IF NOT EXISTS "idx_memories_room_id" ON "memories" ("room_id");

-- Migration: Add device authentication columns and agent snapshots table
-- For milaidy desktop/mobile auto-signup and agent state backup/restore

-- ─── Device identity columns on users table ─────────────────────────────

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "device_id" TEXT UNIQUE;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "device_platform" TEXT;

CREATE INDEX IF NOT EXISTS "users_device_id_idx" ON "users" ("device_id");

-- ─── Agent snapshots table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agent_snapshots" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "container_id" UUID NOT NULL REFERENCES "containers"("id") ON DELETE CASCADE,
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "snapshot_type" TEXT NOT NULL DEFAULT 'manual',
  "storage_url" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL DEFAULT 0,
  "agent_config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_snapshots_container_idx" ON "agent_snapshots" ("container_id");
CREATE INDEX IF NOT EXISTS "agent_snapshots_org_idx" ON "agent_snapshots" ("organization_id");
CREATE INDEX IF NOT EXISTS "agent_snapshots_type_idx" ON "agent_snapshots" ("snapshot_type");
CREATE INDEX IF NOT EXISTS "agent_snapshots_created_idx" ON "agent_snapshots" ("created_at");

-- Migration: Add Milady Sandboxes tables
-- Tracks per-agent Vercel Sandbox allocations and rolling state backups
-- for Milady cloud agents.

CREATE TABLE IF NOT EXISTS "milady_sandboxes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "character_id" uuid REFERENCES "user_characters"("id") ON DELETE SET NULL,

  -- Sandbox infrastructure
  "sandbox_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "bridge_url" text,
  "health_url" text,

  -- Agent configuration
  "agent_name" text,
  "agent_config" jsonb,

  -- Neon database (per-agent isolation)
  "neon_project_id" text,
  "neon_branch_id" text,
  "database_uri" text,
  "database_status" text NOT NULL DEFAULT 'none',
  "database_error" text,

  -- Snapshot / backup tracking
  "snapshot_id" text,
  "last_backup_at" timestamptz,
  "last_heartbeat_at" timestamptz,

  -- Error tracking
  "error_message" text,
  "error_count" integer NOT NULL DEFAULT 0,

  -- Environment overrides
  "environment_vars" jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "milady_sandboxes_organization_idx" ON "milady_sandboxes" ("organization_id");
CREATE INDEX IF NOT EXISTS "milady_sandboxes_user_idx" ON "milady_sandboxes" ("user_id");
CREATE INDEX IF NOT EXISTS "milady_sandboxes_status_idx" ON "milady_sandboxes" ("status");
CREATE INDEX IF NOT EXISTS "milady_sandboxes_character_idx" ON "milady_sandboxes" ("character_id");
CREATE INDEX IF NOT EXISTS "milady_sandboxes_sandbox_id_idx" ON "milady_sandboxes" ("sandbox_id");


CREATE TABLE IF NOT EXISTS "milady_sandbox_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sandbox_record_id" uuid NOT NULL REFERENCES "milady_sandboxes"("id") ON DELETE CASCADE,
  "snapshot_type" text NOT NULL,
  "state_data" jsonb NOT NULL,
  "vercel_snapshot_id" text,
  "size_bytes" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "milady_sandbox_backups_sandbox_idx" ON "milady_sandbox_backups" ("sandbox_record_id");
CREATE INDEX IF NOT EXISTS "milady_sandbox_backups_created_at_idx" ON "milady_sandbox_backups" ("created_at");

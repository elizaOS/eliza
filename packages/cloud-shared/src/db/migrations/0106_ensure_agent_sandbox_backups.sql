-- Ensure the current agent backup table exists even on databases that were
-- migrated from the older eliza/eliza sandbox table names out of order.

CREATE TABLE IF NOT EXISTS "agent_sandbox_backups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sandbox_record_id" uuid NOT NULL REFERENCES "agent_sandboxes"("id") ON DELETE CASCADE,
  "snapshot_type" text NOT NULL,
  "state_data" jsonb NOT NULL,
  "state_data_storage" text NOT NULL DEFAULT 'inline',
  "state_data_key" text,
  "size_bytes" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "state_data_storage" text NOT NULL DEFAULT 'inline';

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "state_data_key" text;

ALTER TABLE "agent_sandbox_backups"
  DROP COLUMN IF EXISTS "vercel_snapshot_id";

CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_sandbox_idx"
  ON "agent_sandbox_backups" ("sandbox_record_id");

CREATE INDEX IF NOT EXISTS "agent_sandbox_backups_created_at_idx"
  ON "agent_sandbox_backups" ("created_at");

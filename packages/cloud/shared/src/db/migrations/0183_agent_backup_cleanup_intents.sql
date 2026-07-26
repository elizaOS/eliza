-- Preserve chunk-object cleanup ownership before sandbox deletion cascades its
-- backup rows. The trigger and sandbox delete commit atomically, so crashes
-- cannot erase the only durable list of objects that still require deletion.
CREATE TABLE IF NOT EXISTS "agent_sandbox_backup_cleanup_intents" (
  "backup_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "sandbox_record_id" uuid NOT NULL,
  "descriptor" jsonb NOT NULL,
  "storage_commit_state" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_sandbox_backup_cleanup_intents_updated_idx"
  ON "agent_sandbox_backup_cleanup_intents" ("updated_at");

CREATE OR REPLACE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "agent_sandbox_backup_cleanup_intents" (
    "backup_id",
    "organization_id",
    "sandbox_record_id",
    "descriptor",
    "storage_commit_state",
    "created_at",
    "updated_at"
  )
  SELECT
    backup."id",
    OLD."organization_id",
    backup."sandbox_record_id",
    backup."state_data_descriptor",
    backup."storage_commit_state",
    now(),
    now()
  FROM "agent_sandbox_backups" backup
  WHERE backup."sandbox_record_id" = OLD."id"
    AND backup."snapshot_schema_version" = 2
    AND backup."state_data_storage" = 'chunked-v2'
  ON CONFLICT ("backup_id") DO UPDATE SET
    "organization_id" = EXCLUDED."organization_id",
    "sandbox_record_id" = EXCLUDED."sandbox_record_id",
    "descriptor" = EXCLUDED."descriptor",
    "storage_commit_state" = EXCLUDED."storage_commit_state",
    "updated_at" = now();
  RETURN OLD;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER "agent_sandboxes_capture_backup_cleanup"
    BEFORE DELETE ON "agent_sandboxes"
    FOR EACH ROW
    EXECUTE FUNCTION "capture_agent_sandbox_backup_cleanup_intents"();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

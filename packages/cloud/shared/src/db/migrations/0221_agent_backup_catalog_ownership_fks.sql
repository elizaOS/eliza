-- The lifecycle coordinator must hand v2 rows to durable GC before deleting
-- their sandbox. Legacy rows retain the historical cascade behavior.
CREATE OR REPLACE FUNCTION block_agent_backup_catalog_v2_sandbox_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_sandbox_backups"
    WHERE "sandbox_record_id" = OLD."id" AND "catalog_version" = 2
  ) THEN
    RAISE EXCEPTION 'sandbox % still owns backup catalog v2 authority', OLD."id";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "agent_sandboxes_block_backup_catalog_v2_delete" ON "agent_sandboxes";
CREATE TRIGGER "agent_sandboxes_block_backup_catalog_v2_delete"
BEFORE DELETE ON "agent_sandboxes"
FOR EACH ROW EXECUTE FUNCTION block_agent_backup_catalog_v2_sandbox_delete();

ALTER TABLE "agent_sandbox_backups"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_sandbox_record_id_fkey";
ALTER TABLE "agent_sandbox_backups"
  ADD CONSTRAINT "agent_sandbox_backups_sandbox_record_id_fkey"
  FOREIGN KEY ("sandbox_record_id") REFERENCES "agent_sandboxes"("id") ON DELETE CASCADE;

ALTER TABLE "agent_sandbox_backups"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_recovery_organization_id_fkey";
ALTER TABLE "agent_sandbox_backups"
  ADD CONSTRAINT "agent_sandbox_backups_recovery_organization_id_fkey"
  FOREIGN KEY ("recovery_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

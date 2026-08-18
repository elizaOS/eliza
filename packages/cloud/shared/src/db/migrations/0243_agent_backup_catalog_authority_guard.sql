-- Catalogue epochs and restore counters are monotone, DB-timestamped, and nondeletable.

CREATE OR REPLACE FUNCTION "guard_agent_backup_catalog_authority"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'backup catalogue authority cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."agent_id" IS DISTINCT FROM OLD."agent_id"
    OR NEW."catalog_revision" < OLD."catalog_revision"
    OR NEW."restore_generation" < OLD."restore_generation" THEN
    RAISE EXCEPTION 'backup catalogue authority cannot change identity or rewind'
      USING ERRCODE = '55000';
  END IF;
  NEW."updated_at" := GREATEST(OLD."updated_at", clock_timestamp());
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_catalog_authority_guard"
  ON "agent_backup_catalog_authorities";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_catalog_authority_guard"
  BEFORE UPDATE OR DELETE ON "agent_backup_catalog_authorities"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_catalog_authority"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_catalog_authority_truncate_guard"
  ON "agent_backup_catalog_authorities";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_catalog_authority_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_catalog_authorities"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_leases_truncate_guard"
  ON "agent_backup_restore_leases";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_leases_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_leases"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();

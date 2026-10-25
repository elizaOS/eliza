-- Keep the durable attempt identity immutable and reject every update after a
-- terminal state has been recorded.

CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt_identity"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD."state" IN ('lifecycle_committed', 'cleanup_proven') THEN
    RAISE EXCEPTION 'terminal replacement attempt is immutable';
  END IF;
  IF NEW."updated_at" < OLD."updated_at" THEN
    RAISE EXCEPTION 'replacement attempt timestamp cannot rewind';
  END IF;
  IF ROW(
    OLD."id", OLD."organization_id", OLD."agent_id", OLD."operation_kind",
    OLD."lifecycle_revision", OLD."activation_generation", OLD."lifecycle_job_id",
    OLD."lifecycle_execution_generation", OLD."restore_lease_id", OLD."restore_backup_id",
    OLD."restore_attempt_id", OLD."restore_lease_owner_id", OLD."restore_lease_generation",
    OLD."restore_catalog_epoch", OLD."restore_copy_role", OLD."restore_operation_id",
    OLD."restore_source_activation_generation", OLD."restore_source_lifecycle_revision",
    OLD."restore_manifest_sha256", OLD."restore_lease_expires_at", OLD."created_at"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."organization_id", NEW."agent_id", NEW."operation_kind",
    NEW."lifecycle_revision", NEW."activation_generation", NEW."lifecycle_job_id",
    NEW."lifecycle_execution_generation", NEW."restore_lease_id", NEW."restore_backup_id",
    NEW."restore_attempt_id", NEW."restore_lease_owner_id", NEW."restore_lease_generation",
    NEW."restore_catalog_epoch", NEW."restore_copy_role", NEW."restore_operation_id",
    NEW."restore_source_activation_generation", NEW."restore_source_lifecycle_revision",
    NEW."restore_manifest_sha256", NEW."restore_lease_expires_at", NEW."created_at"
  ) THEN
    RAISE EXCEPTION 'replacement attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_identity"
  BEFORE UPDATE ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_identity"();

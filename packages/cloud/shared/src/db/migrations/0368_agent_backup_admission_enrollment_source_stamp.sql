-- Extends the sandbox source stamp to every enrollment-eligibility deletion guard.

CREATE OR REPLACE FUNCTION "stamp_agent_backup_admission_xid"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR ROW(
    OLD."id",
    OLD."organization_id",
    OLD."status",
    OLD."pool_status",
    OLD."execution_tier",
    OLD."deleted_at",
    OLD."deletion_attempt_id",
    OLD."sandbox_id",
    OLD."activation_generation",
    OLD."activation_lifecycle_revision",
    OLD."lifecycle_revision",
    OLD."activation_phase",
    OLD."activation_receipt_hash",
    OLD."activation_container_id",
    OLD."activation_node_id",
    OLD."activation_image_digest",
    OLD."activation_boot_id",
    OLD."activation_authority_published_at",
    OLD."activation_dispatched_at",
    OLD."activation_completed_at",
    OLD."next_backup_at",
    OLD."backup_schedule_last_protected_at"
  ) IS DISTINCT FROM ROW(
    NEW."id",
    NEW."organization_id",
    NEW."status",
    NEW."pool_status",
    NEW."execution_tier",
    NEW."deleted_at",
    NEW."deletion_attempt_id",
    NEW."sandbox_id",
    NEW."activation_generation",
    NEW."activation_lifecycle_revision",
    NEW."lifecycle_revision",
    NEW."activation_phase",
    NEW."activation_receipt_hash",
    NEW."activation_container_id",
    NEW."activation_node_id",
    NEW."activation_image_digest",
    NEW."activation_boot_id",
    NEW."activation_authority_published_at",
    NEW."activation_dispatched_at",
    NEW."activation_completed_at",
    NEW."next_backup_at",
    NEW."backup_schedule_last_protected_at"
  ) THEN
    NEW."backup_admission_xid" := pg_current_xact_id();
  ELSE
    NEW."backup_admission_xid" := OLD."backup_admission_xid";
  END IF;
  RETURN NEW;
END
$$;

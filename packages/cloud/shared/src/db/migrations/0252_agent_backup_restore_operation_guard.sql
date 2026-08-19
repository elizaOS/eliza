-- Phase advances are monotone and identity is frozen. Without this a crashed
-- worker's stale write could rewind a phase another worker already advanced,
-- and a lost response would re-run a side effect instead of re-verifying it.

CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_operation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ordinals CONSTANT text[] := ARRAY['reserved','vault_seeded','container_created','restoring',
    'committed','restart_attested','probed','published','finalized'];
  old_rank integer;
  new_rank integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'restore operation authority cannot be deleted: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."agent_id" IS DISTINCT FROM OLD."agent_id"
    OR NEW."backup_id" IS DISTINCT FROM OLD."backup_id"
    OR NEW."restore_attempt_id" IS DISTINCT FROM OLD."restore_attempt_id"
    OR NEW."lease_id" IS DISTINCT FROM OLD."lease_id"
    OR NEW."lease_generation" IS DISTINCT FROM OLD."lease_generation"
    OR NEW."expected_operation_id" IS DISTINCT FROM OLD."expected_operation_id"
    OR NEW."expected_manifest_sha256" IS DISTINCT FROM OLD."expected_manifest_sha256"
    OR NEW."expected_activation_generation" IS DISTINCT FROM OLD."expected_activation_generation"
    OR NEW."expected_lifecycle_revision" IS DISTINCT FROM OLD."expected_lifecycle_revision"
    OR NEW."copy_role" IS DISTINCT FROM OLD."copy_role"
    OR NEW."lease_owner_id" IS DISTINCT FROM OLD."lease_owner_id"
    OR NEW."catalog_epoch" IS DISTINCT FROM OLD."catalog_epoch"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'restore operation identity is immutable: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  -- A recorded side-effect identity is written once; re-writing it would let a
  -- replay adopt a different container or node than the one already acted on.
  IF (OLD."expected_node_record_id" IS NOT NULL
      AND NEW."expected_node_record_id" IS DISTINCT FROM OLD."expected_node_record_id")
    OR (OLD."expected_node_incarnation" IS NOT NULL
      AND NEW."expected_node_incarnation" IS DISTINCT FROM OLD."expected_node_incarnation")
    OR (OLD."expected_container_id" IS NOT NULL
      AND NEW."expected_container_id" IS DISTINCT FROM OLD."expected_container_id")
    OR (OLD."expected_image_digest" IS NOT NULL
      AND NEW."expected_image_digest" IS DISTINCT FROM OLD."expected_image_digest")
    OR (OLD."receipt_digest" IS NOT NULL
      AND NEW."receipt_digest" IS DISTINCT FROM OLD."receipt_digest") THEN
    RAISE EXCEPTION 'restore operation side-effect identity is write-once: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  IF OLD."phase" IN ('finalized', 'failed_terminal')
    AND NEW."phase" IS DISTINCT FROM OLD."phase" THEN
    RAISE EXCEPTION 'restore operation % is terminal in phase %', OLD."id", OLD."phase"
      USING ERRCODE = '55000';
  END IF;

  old_rank := array_position(ordinals, OLD."phase");
  new_rank := array_position(ordinals, NEW."phase");
  IF old_rank IS NOT NULL AND new_rank IS NOT NULL AND new_rank < old_rank THEN
    RAISE EXCEPTION 'restore operation % cannot rewind from % to %',
      OLD."id", OLD."phase", NEW."phase" USING ERRCODE = '55000';
  END IF;
  IF old_rank IS NOT NULL AND new_rank IS NOT NULL AND new_rank > old_rank + 1 THEN
    RAISE EXCEPTION 'restore operation % cannot skip from % to %',
      OLD."id", OLD."phase", NEW."phase" USING ERRCODE = '55000';
  END IF;

  -- Re-entry after a retryable failure resumes exactly the recorded phase.
  IF OLD."phase" = 'failed_retryable' AND NEW."phase" NOT IN ('failed_retryable', 'failed_terminal')
    AND NEW."phase" IS DISTINCT FROM OLD."resume_phase" THEN
    RAISE EXCEPTION 'restore operation % must resume %, not %',
      OLD."id", OLD."resume_phase", NEW."phase" USING ERRCODE = '55000';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_operation_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_operation_guard"
  BEFORE UPDATE OR DELETE ON "agent_backup_restore_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_operation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_operations_truncate_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_operations_truncate_guard"
  BEFORE TRUNCATE ON "agent_backup_restore_operations"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();

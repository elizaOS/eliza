ALTER TABLE "agent_sandbox_backups"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_recovery_shape_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_shape_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_lease_shape_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_sizes_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_state_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_manifest_shape_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_error_bounds_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_restore_receipt_check",
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_delete_receipt_check";

ALTER TABLE "agent_sandbox_backups"
  ADD CONSTRAINT "agent_sandbox_backups_recovery_shape_check" CHECK (((
    "sandbox_record_id" IS NOT NULL
    AND "recovery_organization_id" IS NULL
    AND "recovery_agent_id" IS NULL
    AND "recovery_deletion_attempt_id" IS NULL
    AND "recovery_expires_at" IS NULL
  ) OR (
    "sandbox_record_id" IS NULL AND (
      ("catalog_version" IS NULL
        AND "snapshot_type" = 'pre-delete'
        AND "backup_kind" = 'full'
        AND "parent_backup_id" IS NULL
        AND "verification_status" = 'verified'
        AND "verified_at" IS NOT NULL
        AND "recovery_organization_id" IS NOT NULL
        AND "recovery_agent_id" IS NOT NULL
        AND "recovery_deletion_attempt_id" IS NOT NULL
        AND "recovery_expires_at" IS NOT NULL)
      OR ("catalog_version" IN (1, 2)
        AND "catalog_organization_id" IS NOT NULL
        AND "catalog_agent_id" IS NOT NULL
        AND (("recovery_organization_id" IS NULL
          AND "recovery_agent_id" IS NULL
          AND "recovery_deletion_attempt_id" IS NULL
          AND "recovery_expires_at" IS NULL)
        OR ("recovery_organization_id" = "catalog_organization_id"
          AND "recovery_agent_id" = "catalog_agent_id"
          AND "recovery_deletion_attempt_id" IS NOT NULL
          AND "recovery_expires_at" IS NOT NULL)))
    )
  )) IS TRUE) NOT VALID,
  ADD CONSTRAINT "agent_sandbox_backups_catalog_shape_check" CHECK (((
    "backup_operation_id" IS NULL
    AND "catalog_version" IS NULL
    AND "catalog_state" IS NULL
    AND "catalog_resume_state" IS NULL
    AND "catalog_payload_digest" IS NULL
    AND "catalog_organization_id" IS NULL
    AND "catalog_agent_id" IS NULL
    AND "lifecycle_generation" IS NULL
    AND "lifecycle_revision" IS NULL
  ) OR (
    "backup_operation_id" IS NOT NULL
    AND "catalog_version" IN (1, 2)
    AND "catalog_state" IS NOT NULL
    AND "catalog_payload_digest" ~ '^[0-9a-f]{64}$'
    AND "catalog_organization_id" IS NOT NULL
    AND "catalog_agent_id" IS NOT NULL
    AND "lifecycle_generation" IS NOT NULL
    AND "lifecycle_revision" IS NOT NULL
    AND "lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND (("catalog_version" = 1 AND "catalog_state" = 'legacy_unmigrated')
      OR ("catalog_version" = 2 AND (
        ("backup_kind" = 'full' AND "parent_backup_id" IS NULL AND "base_backup_id" IS NULL)
        OR ("backup_kind" = 'incremental' AND "parent_backup_id" IS NOT NULL AND "base_backup_id" IS NOT NULL)
      )))
    AND (("catalog_state" IN ('failed_retryable', 'failed_terminal')
      AND "catalog_resume_state" IS NOT NULL
      AND "catalog_resume_state" NOT IN ('legacy_unmigrated', 'failed_retryable', 'failed_terminal', 'deleted'))
    OR ("catalog_state" NOT IN ('failed_retryable', 'failed_terminal') AND "catalog_resume_state" IS NULL))
  )) IS TRUE) NOT VALID;

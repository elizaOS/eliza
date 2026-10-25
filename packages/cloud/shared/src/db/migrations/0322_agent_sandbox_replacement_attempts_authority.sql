-- Validate operation, lifecycle, and optional restore authority independently
-- from the table-creation lock.

ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_operation_kind_check" CHECK (
    "operation_kind" IN ('provision', 'upgrade', 'downgrade')
  ),
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_lifecycle_check" CHECK ((
    "lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND (("lifecycle_job_id" IS NULL AND "lifecycle_execution_generation" IS NULL)
      OR ("lifecycle_job_id" IS NOT NULL
        AND "lifecycle_execution_generation" IS NOT NULL))
  ) IS TRUE),
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_restore_shape_check" CHECK ((
    num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at"
    ) = 0
    OR (num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at"
    ) = 12
      AND btrim("restore_lease_owner_id") = "restore_lease_owner_id"
      AND octet_length("restore_lease_owner_id") BETWEEN 1 AND 255
      AND "restore_catalog_epoch" >= 0
      AND "restore_copy_role" IN ('primary', 'secondary')
      AND "restore_source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
      AND "restore_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "restore_lease_expires_at" > "created_at")
  ) IS TRUE);

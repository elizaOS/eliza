DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_lease_shape_check" CHECK ((
      "catalog_lease_owner" IS NULL AND "catalog_lease_generation" IS NULL
        AND "catalog_lease_expires_at" IS NULL
    ) OR (
      "catalog_lease_owner" IS NOT NULL AND "catalog_lease_owner" <> ''
        AND "catalog_lease_generation" IS NOT NULL AND "catalog_lease_expires_at" IS NOT NULL
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_state_check" CHECK (
      "catalog_state" IS NULL OR "catalog_state" IN (
        'legacy_unmigrated', 'scheduled', 'capturing', 'captured', 'uploading',
        'primary_uploaded', 'primary_verified', 'secondary_pending', 'protected',
        'retained', 'expiration_pending', 'deleting', 'deleted',
        'failed_retryable', 'failed_terminal', 'restore_verified'
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_retention_reason_check" CHECK ((
      "catalog_version" IS DISTINCT FROM 2 OR ("retention_reason" IS NOT NULL AND "retention_reason" IN (
        'schedule', 'manual', 'pre-shutdown', 'pre-delete', 'pre-upgrade',
        'pre-move', 'billing-freeze', 'legal-hold', 'user-erasure'
      ))
    ) IS TRUE) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_sizes_check" CHECK (
      COALESCE("raw_size_bytes", 0) >= 0 AND COALESCE("compressed_size_bytes", 0) >= 0
      AND COALESCE("encrypted_size_bytes", 0) >= 0
      AND ("manifest_object_count" IS NULL OR "manifest_object_count" BETWEEN 1 AND 8192)
      AND "catalog_attempts" >= 0 AND "catalog_revision" >= 0
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_error_bounds_check" CHECK (
      ("catalog_last_error_code" IS NULL OR length("catalog_last_error_code") <= 96)
      AND ("catalog_last_error" IS NULL OR length("catalog_last_error") <= 2048)
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_restore_receipt_check" CHECK ((
      ("catalog_state" IS DISTINCT FROM 'restore_verified' OR (
        "restore_receipt_digest" ~ '^[0-9a-f]{64}$'
        AND "restore_generation" IS NOT NULL AND "restore_verified_at" IS NOT NULL
      )) AND (("restore_receipt_digest" IS NULL
        AND "restore_generation" IS NULL AND "restore_verified_at" IS NULL)
      OR ("restore_receipt_digest" ~ '^[0-9a-f]{64}$'
        AND "restore_generation" IS NOT NULL AND "restore_verified_at" IS NOT NULL))
    ) IS TRUE) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_delete_receipt_check" CHECK ((
      ("catalog_state" IS DISTINCT FROM 'deleted'
        AND "catalog_delete_receipt_digest" IS NULL AND "catalog_deleted_at" IS NULL)
      OR ("catalog_state" = 'deleted'
        AND "catalog_delete_receipt_digest" ~ '^[0-9a-f]{64}$'
        AND "catalog_deleted_at" IS NOT NULL)
    ) IS TRUE) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

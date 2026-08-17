DO $$ BEGIN
ALTER TABLE "agent_sandbox_backups"
  ADD CONSTRAINT "agent_sandbox_backups_catalog_manifest_shape_check" CHECK ((
    "catalog_version" IS DISTINCT FROM 2 OR (
      (("catalog_state" IN ('scheduled', 'capturing')
        OR ("catalog_state" IN ('failed_retryable', 'failed_terminal')
          AND "catalog_resume_state" IN ('scheduled', 'capturing')))
        AND "manifest_digest" IS NULL
        AND "manifest_canonical_draft" IS NULL
        AND "wrapped_dek_ref" IS NULL
        AND "wrapped_dek_ciphertext_base64" IS NULL
        AND "wrapped_dek_sha256" IS NULL
        AND "wrapped_dek_size_bytes" IS NULL
        AND "wrapped_dek_receipt_digest" IS NULL)
      OR ((
        "catalog_state" IN (
          'captured', 'uploading', 'primary_uploaded', 'primary_verified',
          'secondary_pending', 'protected', 'retained', 'expiration_pending',
          'deleting', 'deleted', 'restore_verified'
        )
        OR ("catalog_state" = 'failed_retryable' AND "catalog_resume_state" IN (
          'captured', 'uploading', 'primary_uploaded', 'primary_verified',
          'secondary_pending', 'protected', 'retained', 'expiration_pending',
          'deleting', 'restore_verified'
        ))
        OR ("catalog_state" = 'failed_terminal' AND "catalog_resume_state" IN (
          'captured', 'uploading', 'primary_uploaded', 'primary_verified',
          'secondary_pending', 'protected', 'retained', 'expiration_pending',
          'deleting', 'restore_verified'
        )))
        AND "manifest_format" = 'elizaos.agent-backup'
        AND "manifest_version" = 2
        AND "manifest_digest" ~ '^[0-9a-f]{64}$'
        AND octet_length("manifest_canonical_draft") BETWEEN 1 AND 4194304
        AND "manifest_object_count" BETWEEN 1 AND 8192
        AND "object_inventory_digest" ~ '^[0-9a-f]{64}$'
        AND "backup_image_digest" IS NOT NULL AND "backup_image_digest" <> ''
        AND "database_schema_version" IS NOT NULL
        AND "plugin_set_digest" ~ '^[0-9a-f]{64}$'
        AND "watermark_digest" ~ '^[0-9a-f]{64}$'
        AND "raw_size_bytes" IS NOT NULL
        AND "compressed_size_bytes" IS NOT NULL
        AND "encrypted_size_bytes" IS NOT NULL
        AND "backup_kms_key_id" IS NOT NULL AND "backup_kms_key_id" <> ''
        AND "backup_kms_key_version" BETWEEN 1 AND 9007199254740991
        AND "wrapped_dek_ref" IS NOT NULL AND "wrapped_dek_ref" <> ''
        AND octet_length("wrapped_dek_ciphertext_base64") BETWEEN 4 AND 21848
        AND "wrapped_dek_sha256" ~ '^[0-9a-f]{64}$'
        AND "wrapped_dek_size_bytes" BETWEEN 1 AND 16384
        AND "wrapped_dek_receipt_digest" ~ '^[0-9a-f]{64}$')
    )
  ) IS TRUE) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

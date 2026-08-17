-- Enforce mutually exclusive v2 wrapped-DEK and v3 operation-key/vault shapes.
-- NOT VALID preserves rollout compatibility while every new or updated row is checked.

ALTER TABLE "agent_sandbox_backups"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_backups_catalog_manifest_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
  "agent_sandbox_backups_catalog_manifest_shape_check" CHECK ((
  "catalog_version" IS DISTINCT FROM 2 OR (
    (("catalog_state" IN ('scheduled', 'capturing') OR
      ("catalog_state" IN ('failed_retryable', 'failed_terminal') AND
       "catalog_resume_state" IN ('scheduled', 'capturing'))) AND num_nonnulls(
      "manifest_format", "manifest_version", "manifest_digest", "manifest_canonical_draft",
      "manifest_object_count", "object_inventory_digest", "backup_image_digest",
      "database_schema_version", "plugin_set_digest", "watermark_digest", "raw_size_bytes",
      "compressed_size_bytes", "encrypted_size_bytes", "backup_kms_key_id",
      "backup_kms_key_version", "wrapped_dek_ref", "wrapped_dek_ciphertext_base64",
      "wrapped_dek_sha256", "wrapped_dek_size_bytes", "wrapped_dek_receipt_digest",
      "operation_key_bundle_generation_id", "operation_key_bundle_format",
      "operation_key_bundle_ref", "operation_key_bundle_ciphertext_base64",
      "operation_key_bundle_sha256", "operation_key_bundle_size_bytes",
      "operation_key_bundle_context", "operation_key_bundle_context_derivation",
      "operation_key_bundle_local_receipt_derivation",
      "operation_key_bundle_local_receipt_digest", "vault_key_generation_id",
      "vault_key_authority_receipt_digest") = 0)
    OR (("catalog_state" IN ('captured', 'uploading', 'primary_uploaded', 'primary_verified',
      'secondary_pending', 'protected', 'retained', 'expiration_pending', 'deleting', 'deleted',
      'restore_verified') OR ("catalog_state" IN ('failed_retryable', 'failed_terminal') AND
      "catalog_resume_state" IN ('captured', 'uploading', 'primary_uploaded', 'primary_verified',
      'secondary_pending', 'protected', 'retained', 'expiration_pending', 'deleting',
      'restore_verified')))
      AND "manifest_format" = 'elizaos.agent-backup' AND "manifest_version" IN (2, 3)
      AND "manifest_digest" ~ '^[0-9a-f]{64}$' AND "manifest_canonical_draft" IS NOT NULL
      AND octet_length("manifest_canonical_draft") BETWEEN 1 AND 4194304
      AND "manifest_object_count" BETWEEN 1 AND 8192
      AND "object_inventory_digest" ~ '^[0-9a-f]{64}$'
      AND "backup_image_digest" IS NOT NULL AND "backup_image_digest" <> ''
      AND "database_schema_version" IS NOT NULL AND "plugin_set_digest" ~ '^[0-9a-f]{64}$'
      AND "watermark_digest" ~ '^[0-9a-f]{64}$' AND "raw_size_bytes" IS NOT NULL
      AND "compressed_size_bytes" IS NOT NULL AND "encrypted_size_bytes" IS NOT NULL
      AND "backup_kms_key_id" IS NOT NULL AND "backup_kms_key_id" <> ''
      AND "backup_kms_key_version" BETWEEN 1 AND 9007199254740991
      AND (("manifest_version" = 2 AND num_nulls("wrapped_dek_ref",
        "wrapped_dek_ciphertext_base64", "wrapped_dek_sha256", "wrapped_dek_size_bytes",
        "wrapped_dek_receipt_digest") = 0 AND "wrapped_dek_ref" <> ''
        AND octet_length("wrapped_dek_ciphertext_base64") BETWEEN 4 AND 21848
        AND "wrapped_dek_sha256" ~ '^[0-9a-f]{64}$'
        AND "wrapped_dek_size_bytes" BETWEEN 1 AND 16384
        AND "wrapped_dek_receipt_digest" ~ '^[0-9a-f]{64}$' AND num_nonnulls(
          "operation_key_bundle_generation_id", "operation_key_bundle_format",
          "operation_key_bundle_ref", "operation_key_bundle_ciphertext_base64",
          "operation_key_bundle_sha256", "operation_key_bundle_size_bytes",
          "operation_key_bundle_context", "operation_key_bundle_context_derivation",
          "operation_key_bundle_local_receipt_derivation",
          "operation_key_bundle_local_receipt_digest", "vault_key_generation_id",
          "vault_key_authority_receipt_digest") = 0)
      OR ("manifest_version" = 3 AND num_nonnulls("wrapped_dek_ref",
        "wrapped_dek_ciphertext_base64", "wrapped_dek_sha256", "wrapped_dek_size_bytes",
        "wrapped_dek_receipt_digest") = 0 AND num_nulls(
          "operation_key_bundle_generation_id", "operation_key_bundle_format",
          "operation_key_bundle_ref", "operation_key_bundle_ciphertext_base64",
          "operation_key_bundle_sha256", "operation_key_bundle_size_bytes",
          "operation_key_bundle_context", "operation_key_bundle_context_derivation",
          "operation_key_bundle_local_receipt_derivation",
          "operation_key_bundle_local_receipt_digest", "vault_key_generation_id",
          "vault_key_authority_receipt_digest") = 0
        AND "operation_key_bundle_format" = 'kms-aead-operation-key-bundle-v1'
        AND "operation_key_bundle_ref" = 'backup-key-bundle:' || "backup_operation_id"::text
        AND "operation_key_bundle_ciphertext_base64" ~ '^[A-Za-z0-9+/]{123}=$'
        AND "operation_key_bundle_sha256" ~ '^[0-9a-f]{64}$'
        AND "operation_key_bundle_size_bytes" = 92
        AND octet_length("operation_key_bundle_context") BETWEEN 1 AND 65536
        AND "operation_key_bundle_context_derivation" =
          'elizaos.agent-backup.operation-key-bundle-context.v1'
        AND "operation_key_bundle_local_receipt_derivation" =
          'elizaos.kms-aead-operation-key-bundle.local-receipt.v1'
        AND "operation_key_bundle_local_receipt_digest" ~ '^[0-9a-f]{64}$'
        AND "vault_key_authority_receipt_digest" ~ '^[0-9a-f]{64}$')))
  )) IS TRUE) NOT VALID;

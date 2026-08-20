-- Final restore proof closes only over immutable source, seed, boot, and publication rows.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandbox_backups_final_restore_authority_unique') THEN ALTER TABLE
    "agent_sandbox_backups" ADD CONSTRAINT
    "agent_sandbox_backups_final_restore_authority_unique" UNIQUE
    ("id", "catalog_organization_id", "catalog_agent_id", "backup_operation_id",
      "lifecycle_generation", "lifecycle_revision", "manifest_digest"); END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_receipts" (
  "id" uuid PRIMARY KEY, "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE RESTRICT, "agent_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL, "backup_id" uuid NOT NULL, "operation_id" uuid NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" numeric(20, 0) NOT NULL, "manifest_sha256" text NOT NULL,
  "seed_receipt_id" uuid NOT NULL, "seed_receipt_digest" text NOT NULL,
  "target_activation_generation" uuid NOT NULL, "activation_purpose" text NOT NULL,
  "activation_publication_id" uuid NOT NULL, "activation_receipt_sha256" text NOT NULL,
  "restore_generation" bigint NOT NULL, "receipt_digest" text NOT NULL,
  "verified_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "agent_backup_restore_receipts_attempt_unique" UNIQUE
    ("organization_id", "restore_attempt_id"),
  CONSTRAINT "agent_backup_restore_receipts_seed_receipt_fkey" FOREIGN KEY
    ("seed_receipt_id", "organization_id", "agent_id", "restore_attempt_id",
      "backup_id", "operation_id", "source_activation_generation",
      "source_lifecycle_revision", "manifest_sha256", "target_activation_generation",
      "seed_receipt_digest") REFERENCES
    "agent_vault_key_seed_receipts" ("id", "organization_id", "agent_id",
      "restore_attempt_id", "backup_id", "operation_id", "source_activation_generation",
      "source_lifecycle_revision", "manifest_sha256",
      "target_activation_generation", "receipt_digest") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_receipts_activation_publication_fkey" FOREIGN KEY
    ("activation_publication_id", "organization_id", "agent_id",
      "target_activation_generation", "activation_purpose", "backup_id",
      "manifest_sha256", "activation_receipt_sha256")
    REFERENCES "agent_activation_publications" ("id", "organization_id", "agent_id",
      "activation_generation", "purpose", "backup_id", "backup_manifest_sha256",
      "activation_receipt_sha256") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_receipts_backup_authority_fkey" FOREIGN KEY
    ("backup_id", "organization_id", "agent_id", "operation_id",
      "source_activation_generation", "source_lifecycle_revision", "manifest_sha256") REFERENCES
    "agent_sandbox_backups" ("id", "catalog_organization_id", "catalog_agent_id",
      "backup_operation_id", "lifecycle_generation", "lifecycle_revision",
      "manifest_digest") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_restore_receipts_shape_check" CHECK ((
    "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "activation_purpose" = 'restore' AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "seed_receipt_digest" ~ '^[0-9a-f]{64}$'
    AND "activation_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND "receipt_digest" ~ '^[0-9a-f]{64}$' AND "restore_generation" > 0) IS TRUE)
);

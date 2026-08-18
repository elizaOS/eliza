-- Candidate keys for exact restore-source and immutable vault-binding FKs.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandbox_backups_restore_authority_unique'
    AND conrelid = 'agent_sandbox_backups'::regclass) THEN
    ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
      "agent_sandbox_backups_restore_authority_unique" UNIQUE (
        "id", "catalog_organization_id", "catalog_agent_id", "backup_operation_id",
        "lifecycle_generation", "lifecycle_revision", "manifest_digest");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandbox_backups_vault_restore_authority_unique'
    AND conrelid = 'agent_sandbox_backups'::regclass) THEN
    ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
      "agent_sandbox_backups_vault_restore_authority_unique" UNIQUE (
        "id", "catalog_organization_id", "catalog_agent_id", "backup_operation_id",
        "lifecycle_generation", "lifecycle_revision", "manifest_digest",
        "vault_key_generation_id", "vault_key_authority_receipt_digest");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandboxes_activation_backup_authority_fkey'
    AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_activation_backup_authority_fkey"
      FOREIGN KEY ("activation_backup_id", "organization_id", "id")
      REFERENCES "agent_sandbox_backups"
        ("id", "catalog_organization_id", "catalog_agent_id")
      ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" VALIDATE CONSTRAINT
  "agent_sandboxes_activation_backup_authority_fkey";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandboxes_activation_consent_backup_authority_fkey'
    AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_activation_consent_backup_authority_fkey"
      FOREIGN KEY ("activation_consent_head_backup_id", "organization_id", "id")
      REFERENCES "agent_sandbox_backups"
        ("id", "catalog_organization_id", "catalog_agent_id")
      ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" VALIDATE CONSTRAINT
  "agent_sandboxes_activation_consent_backup_authority_fkey";

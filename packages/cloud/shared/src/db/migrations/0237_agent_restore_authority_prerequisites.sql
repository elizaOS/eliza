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

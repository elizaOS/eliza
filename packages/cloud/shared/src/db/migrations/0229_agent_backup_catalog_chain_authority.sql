DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_attached_catalog_tenant_fkey"
    FOREIGN KEY ("sandbox_record_id", "catalog_organization_id")
    REFERENCES "agent_sandboxes"("id", "organization_id")
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_parent_catalog_authority_fkey"
    FOREIGN KEY ("parent_backup_id", "catalog_organization_id", "catalog_agent_id")
    REFERENCES "agent_sandbox_backups"("id", "catalog_organization_id", "catalog_agent_id")
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_base_catalog_authority_fkey"
    FOREIGN KEY ("base_backup_id", "catalog_organization_id", "catalog_agent_id")
    REFERENCES "agent_sandbox_backups"("id", "catalog_organization_id", "catalog_agent_id")
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "agent_sandbox_backups"
  VALIDATE CONSTRAINT "agent_sandbox_backups_attached_catalog_identity_check";
ALTER TABLE "agent_sandbox_backups"
  VALIDATE CONSTRAINT "agent_sandbox_backups_catalog_authority_fkey";
ALTER TABLE "agent_sandbox_backups"
  VALIDATE CONSTRAINT "agent_sandbox_backups_attached_catalog_tenant_fkey";
ALTER TABLE "agent_sandbox_backups"
  VALIDATE CONSTRAINT "agent_sandbox_backups_parent_catalog_authority_fkey";
ALTER TABLE "agent_sandbox_backups"
  VALIDATE CONSTRAINT "agent_sandbox_backups_base_catalog_authority_fkey";

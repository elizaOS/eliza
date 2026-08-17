DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandboxes_id_organization_unique'
      AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_id_organization_unique"
      UNIQUE ("id", "organization_id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_catalog_chain_identity_unique'
      AND conrelid = 'agent_sandbox_backups'::regclass) THEN
    ALTER TABLE "agent_sandbox_backups"
      ADD CONSTRAINT "agent_sandbox_backups_catalog_chain_identity_unique"
      UNIQUE ("id", "catalog_organization_id", "catalog_agent_id");
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_attached_catalog_identity_check" CHECK ((
      "sandbox_record_id" IS NULL OR "catalog_version" IS NULL OR (
        "catalog_organization_id" IS NOT NULL
        AND "catalog_agent_id" = "sandbox_record_id"
      )
    ) IS TRUE) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_authority_fkey"
    FOREIGN KEY ("catalog_organization_id", "catalog_agent_id")
    REFERENCES "agent_backup_catalog_authorities"("organization_id", "agent_id")
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Durable restore lease core. Lifecycle revision matches the catalogue's uint64 numeric authority.

CREATE TABLE IF NOT EXISTS "agent_backup_restore_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "activation_generation" uuid NOT NULL,
  "lifecycle_revision" numeric(20, 0) NOT NULL,
  "expected_manifest_sha256" text NOT NULL,
  "copy_role" text NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "generation" uuid NOT NULL,
  "catalog_epoch" bigint NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "released_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_backup_restore_leases_backup_authority_fkey'
    AND conrelid = 'agent_backup_restore_leases'::regclass) THEN
    ALTER TABLE "agent_backup_restore_leases" ADD CONSTRAINT
      "agent_backup_restore_leases_backup_authority_fkey" FOREIGN KEY (
        "backup_id", "organization_id", "agent_id", "operation_id",
        "activation_generation", "lifecycle_revision", "expected_manifest_sha256")
      REFERENCES "agent_sandbox_backups" (
        "id", "catalog_organization_id", "catalog_agent_id", "backup_operation_id",
        "lifecycle_generation", "lifecycle_revision", "manifest_digest") ON DELETE RESTRICT;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_backup_restore_leases_catalog_authority_fkey'
    AND conrelid = 'agent_backup_restore_leases'::regclass) THEN
    ALTER TABLE "agent_backup_restore_leases" ADD CONSTRAINT
      "agent_backup_restore_leases_catalog_authority_fkey" FOREIGN KEY
      ("organization_id", "agent_id") REFERENCES "agent_backup_catalog_authorities"
      ("organization_id", "agent_id") ON DELETE RESTRICT;
  END IF;
END $$;

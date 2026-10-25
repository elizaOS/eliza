-- Bind an exact manifest-v3 source to the retained vault generation it authenticates.

CREATE TABLE IF NOT EXISTS "agent_vault_key_backup_bindings" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" numeric(20, 0) NOT NULL,
  "manifest_sha256" text NOT NULL,
  "vault_key_generation_id" uuid NOT NULL,
  "vault_key_authority_receipt_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("organization_id", "backup_id"),
  CONSTRAINT "agent_vault_key_backup_bindings_backup_authority_fkey" FOREIGN KEY (
    "backup_id", "organization_id", "agent_id", "operation_id",
    "source_activation_generation", "source_lifecycle_revision", "manifest_sha256",
    "vault_key_generation_id", "vault_key_authority_receipt_digest")
    REFERENCES "agent_sandbox_backups" (
    "id", "catalog_organization_id", "catalog_agent_id", "backup_operation_id",
    "lifecycle_generation", "lifecycle_revision", "manifest_digest",
    "vault_key_generation_id", "vault_key_authority_receipt_digest") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_backup_bindings_generation_authority_fkey" FOREIGN KEY (
    "organization_id", "agent_id", "vault_key_generation_id",
    "vault_key_authority_receipt_digest") REFERENCES "agent_vault_key_generations" (
    "organization_id", "agent_id", "generation_id", "authority_receipt_digest")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_backup_bindings_manifest_check" CHECK ((
    "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "vault_key_authority_receipt_digest" ~ '^[0-9a-f]{64}$'
  ) IS TRUE)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_backup_bindings_immutable"
  ON "agent_vault_key_backup_bindings";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_backup_bindings_immutable"
  BEFORE UPDATE OR DELETE ON "agent_vault_key_backup_bindings"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_backup_bindings_truncate_guard"
  ON "agent_vault_key_backup_bindings";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_backup_bindings_truncate_guard"
  BEFORE TRUNCATE ON "agent_vault_key_backup_bindings"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();

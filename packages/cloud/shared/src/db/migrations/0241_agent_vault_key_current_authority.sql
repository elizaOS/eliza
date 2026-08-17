-- One monotone pointer selects the current immutable vault-key generation.

CREATE TABLE IF NOT EXISTS "agent_vault_key_authorities" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "current_generation_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("organization_id", "agent_id"),
  CONSTRAINT "agent_vault_key_authorities_catalog_authority_fkey" FOREIGN KEY
    ("organization_id", "agent_id") REFERENCES "agent_backup_catalog_authorities"
    ("organization_id", "agent_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_authorities_generation_fkey" FOREIGN KEY
    ("organization_id", "agent_id", "current_generation_id")
    REFERENCES "agent_vault_key_generations"
    ("organization_id", "agent_id", "generation_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_authorities_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_authorities_truncate_guard"
  ON "agent_vault_key_authorities";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_authorities_truncate_guard"
  BEFORE TRUNCATE ON "agent_vault_key_authorities"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();

-- Immutable KMS envelopes are rooted in the durable catalogue authority, not compute rows.

CREATE TABLE IF NOT EXISTS "agent_vault_key_generations" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "generation_id" uuid NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "supersedes_generation_id" uuid,
  "format" text NOT NULL,
  "kms_key_id" text NOT NULL,
  "kms_key_version" bigint NOT NULL,
  "kms_context" text NOT NULL,
  "kms_context_derivation" text NOT NULL,
  "wrapped_ciphertext_base64" text NOT NULL,
  "wrapped_nonce_base64" text NOT NULL,
  "wrapped_auth_tag_base64" text NOT NULL,
  "wrapped_envelope_sha256" text NOT NULL,
  "authority_receipt_derivation" text NOT NULL,
  "authority_receipt_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("organization_id", "agent_id", "generation_id"),
  CONSTRAINT "agent_vault_key_generations_catalog_authority_fkey" FOREIGN KEY
    ("organization_id", "agent_id") REFERENCES "agent_backup_catalog_authorities"
    ("organization_id", "agent_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_generations_supersedes_fkey" FOREIGN KEY
    ("organization_id", "agent_id", "supersedes_generation_id")
    REFERENCES "agent_vault_key_generations"
    ("organization_id", "agent_id", "generation_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_generations_receipt_authority_unique" UNIQUE
    ("organization_id", "agent_id", "generation_id", "authority_receipt_digest"),
  CONSTRAINT "agent_vault_key_generations_envelope_shape_check" CHECK ((
    "format" = 'kms-aead-vault-passphrase-v1'
    AND "kms_key_id" = btrim("kms_key_id")
    AND octet_length("kms_key_id") BETWEEN 1 AND 512
    AND "kms_key_version" BETWEEN 1 AND 9007199254740991
    AND octet_length("kms_context") BETWEEN 1 AND 65536
    AND "kms_context_derivation" = 'elizaos.agent-vault-key.kms-context.v1'
    AND "wrapped_ciphertext_base64" ~ '^[A-Za-z0-9+/]{43}=$'
    AND "wrapped_nonce_base64" ~ '^[A-Za-z0-9+/]{16}$'
    AND "wrapped_auth_tag_base64" ~ '^[A-Za-z0-9+/]{22}==$'
    AND "wrapped_envelope_sha256" ~ '^[0-9a-f]{64}$'
    AND "authority_receipt_derivation" = 'elizaos.agent-vault-key.authority-receipt.v1'
    AND "authority_receipt_digest" ~ '^[0-9a-f]{64}$'
    AND "supersedes_generation_id" IS DISTINCT FROM "generation_id"
  ) IS TRUE)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_agent_restore_immutable_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable restore authority cannot be %: %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_generations_immutable" ON "agent_vault_key_generations";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_generations_immutable"
  BEFORE UPDATE OR DELETE ON "agent_vault_key_generations"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_generations_truncate_guard"
  ON "agent_vault_key_generations";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_generations_truncate_guard"
  BEFORE TRUNCATE ON "agent_vault_key_generations"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();

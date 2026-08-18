-- A vault seed binds the exact live lease, retained key, and immutable target boot.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_backup_restore_leases_receipt_authority_unique') THEN ALTER TABLE
    "agent_backup_restore_leases" ADD CONSTRAINT
    "agent_backup_restore_leases_receipt_authority_unique" UNIQUE
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
      "owner_id", "generation"); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_vault_key_backup_bindings_receipt_authority_unique') THEN ALTER TABLE
    "agent_vault_key_backup_bindings" ADD CONSTRAINT
    "agent_vault_key_backup_bindings_receipt_authority_unique" UNIQUE
    ("organization_id", "agent_id", "backup_id", "operation_id",
      "source_activation_generation", "source_lifecycle_revision", "manifest_sha256",
      "vault_key_generation_id", "vault_key_authority_receipt_digest"); END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_vault_key_seed_receipts" (
  "id" uuid PRIMARY KEY, "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE RESTRICT, "agent_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL, "lease_id" uuid NOT NULL,
  "lease_owner_id" text NOT NULL, "lease_fencing_token" uuid NOT NULL,
  "lease_expires_at" timestamptz NOT NULL, "backup_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL, "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" numeric(20, 0) NOT NULL, "manifest_sha256" text NOT NULL,
  "vault_key_generation_id" uuid NOT NULL,
  "vault_key_authority_receipt_digest" text NOT NULL,
  "target_activation_generation" uuid NOT NULL, "node_history_id" uuid NOT NULL,
  "docker_node_record_id" uuid NOT NULL, "node_incarnation" uuid NOT NULL,
  "receipt_digest" text NOT NULL, "seeded_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "agent_vault_key_seed_receipts_attempt_unique" UNIQUE
    ("organization_id", "restore_attempt_id"),
  CONSTRAINT "agent_vault_key_seed_receipts_receipt_authority_unique" UNIQUE
    ("id", "organization_id", "agent_id", "restore_attempt_id",
      "backup_id", "operation_id", "source_activation_generation",
      "source_lifecycle_revision", "manifest_sha256", "target_activation_generation",
      "receipt_digest"),
  CONSTRAINT "agent_vault_key_seed_receipts_lease_authority_fkey" FOREIGN KEY
    ("lease_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
      "lease_owner_id", "lease_fencing_token") REFERENCES "agent_backup_restore_leases"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
      "owner_id", "generation") ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_seed_receipts_vault_binding_fkey" FOREIGN KEY
    ("organization_id", "agent_id", "backup_id", "operation_id",
      "source_activation_generation", "source_lifecycle_revision", "manifest_sha256",
      "vault_key_generation_id", "vault_key_authority_receipt_digest") REFERENCES
    "agent_vault_key_backup_bindings" ("organization_id", "agent_id", "backup_id",
      "operation_id", "source_activation_generation", "source_lifecycle_revision",
      "manifest_sha256", "vault_key_generation_id", "vault_key_authority_receipt_digest")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_seed_receipts_node_history_fkey" FOREIGN KEY
    ("node_history_id", "docker_node_record_id", "node_incarnation") REFERENCES
    "agent_node_incarnation_histories" ("id", "docker_node_record_id", "node_incarnation")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_vault_key_seed_receipts_shape_check" CHECK ((
    "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "vault_key_authority_receipt_digest" ~ '^[0-9a-f]{64}$'
    AND "receipt_digest" ~ '^[0-9a-f]{64}$' AND "lease_owner_id" = btrim("lease_owner_id")
    AND octet_length("lease_owner_id") BETWEEN 1 AND 255) IS TRUE)
);

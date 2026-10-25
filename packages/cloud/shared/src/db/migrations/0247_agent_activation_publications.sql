-- Immutable publication copies routing authority out of the mutable sandbox row.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandbox_backups_publication_backup_authority_unique') THEN
    ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
      "agent_sandbox_backups_publication_backup_authority_unique" UNIQUE
      ("id", "catalog_organization_id", "catalog_agent_id", "manifest_digest");
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_activation_publications" (
  "id" uuid PRIMARY KEY, "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL, "activation_generation" uuid NOT NULL,
  "previous_activation_generation" uuid, "lifecycle_revision" numeric(20, 0) NOT NULL,
  "purpose" text NOT NULL, "backup_id" uuid, "backup_manifest_sha256" text,
  "activation_receipt" jsonb NOT NULL, "activation_receipt_sha256" text NOT NULL,
  "container_id" text NOT NULL, "node_history_id" uuid NOT NULL,
  "docker_node_record_id" uuid NOT NULL, "node_id" text NOT NULL,
  "node_incarnation" uuid NOT NULL, "image_digest" text NOT NULL,
  "token_sha256" text NOT NULL, "funding_revision" bigint NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "agent_activation_publications_activation_unique" UNIQUE
    ("organization_id", "agent_id", "activation_generation"),
  CONSTRAINT "agent_activation_publications_receipt_authority_unique" UNIQUE
    ("id", "organization_id", "agent_id", "activation_generation", "purpose",
      "backup_id", "backup_manifest_sha256", "activation_receipt_sha256"),
  CONSTRAINT "agent_activation_publications_node_history_fkey" FOREIGN KEY
    ("node_history_id", "docker_node_record_id", "node_incarnation") REFERENCES
    "agent_node_incarnation_histories" ("id", "docker_node_record_id", "node_incarnation")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_activation_publications_backup_authority_fkey" FOREIGN KEY
    ("backup_id", "organization_id", "agent_id", "backup_manifest_sha256") REFERENCES
    "agent_sandbox_backups" ("id", "catalog_organization_id", "catalog_agent_id",
      "manifest_digest") ON DELETE RESTRICT,
  CONSTRAINT "agent_activation_publications_shape_check" CHECK ((
    "lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "purpose" IN ('provision', 'wake', 'restore', 'fresh_boot')
    AND (("backup_id" IS NULL AND "backup_manifest_sha256" IS NULL
      AND "purpose" <> 'restore') OR ("backup_id" IS NOT NULL
      AND "backup_manifest_sha256" ~ '^[0-9a-f]{64}$'))
    AND "activation_receipt_sha256" ~ '^[0-9a-f]{64}$'
    AND "container_id" ~ '^[0-9a-f]{64}$'
    AND "image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "token_sha256" ~ '^[0-9a-f]{64}$' AND "funding_revision" >= 0) IS TRUE)
);

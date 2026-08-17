CREATE TABLE IF NOT EXISTS "agent_backup_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "backup_id" uuid NOT NULL,
  "copy_role" text NOT NULL,
  "component" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'reserved',
  "transport" text NOT NULL,
  "provider" text NOT NULL,
  "endpoint_alias" text NOT NULL,
  "endpoint_identity_fingerprint" text NOT NULL,
  "bucket" text NOT NULL,
  "region" text NOT NULL,
  "object_key" text NOT NULL,
  "key_fingerprint" text NOT NULL,
  "provider_write_started" boolean NOT NULL DEFAULT FALSE,
  "provider_version_id" text,
  "content_hmac_sha256" text NOT NULL,
  "ciphertext_sha256" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "provider_etag" text,
  "provider_checksum" text,
  "upload_receipt_digest" text,
  "delete_receipt_digest" text,
  "verified_at" timestamptz,
  "deleted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "agent_backup_objects_backup_tenant_fkey"
    FOREIGN KEY ("backup_id", "organization_id")
    REFERENCES "agent_sandbox_backups"("id", "catalog_organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_objects_tenant_identity_unique" UNIQUE ("id", "organization_id"),
  CONSTRAINT "agent_backup_objects_state_check" CHECK ("state" IN (
    'reserved', 'uploading', 'present', 'verified',
    'delete_pending', 'deleting', 'deleted', 'quarantined'
  )),
  CONSTRAINT "agent_backup_objects_copy_authority_check" CHECK (
    ("copy_role" = 'primary' AND "provider" = 'cloudflare-r2'
      AND "transport" IN ('worker-r2', 's3-compatible'))
    OR ("copy_role" = 'secondary' AND "provider" = 'hetzner-object-storage'
      AND "transport" = 's3-compatible')
  ),
  CONSTRAINT "agent_backup_objects_locator_check" CHECK (
    "endpoint_alias" <> '' AND "endpoint_identity_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
    AND "bucket" <> '' AND "region" <> '' AND "object_key" <> ''
    AND "key_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "content_hmac_sha256" ~ '^[0-9a-f]{64}$'
    AND "ciphertext_sha256" ~ '^[0-9a-f]{64}$'
    AND ("provider_version_id" IS NULL OR "provider_version_id" <> '')
    AND ("provider_etag" IS NULL OR "provider_etag" <> '')
    AND ("provider_checksum" IS NULL
      OR "provider_checksum" ~ '^sha256:base64:[A-Za-z0-9+/]{43}=$')
    AND "chunk_index" >= 0 AND "size_bytes" >= 0
  ),
  CONSTRAINT "agent_backup_objects_receipt_shape_check" CHECK ((
    "state" NOT IN ('verified', 'deleted')
    OR ("state" = 'verified' AND "upload_receipt_digest" ~ '^[0-9a-f]{64}$' AND "verified_at" IS NOT NULL)
    OR ("state" = 'deleted' AND "delete_receipt_digest" ~ '^[0-9a-f]{64}$' AND "deleted_at" IS NOT NULL)
  ) IS TRUE),
  CONSTRAINT "agent_backup_objects_provider_write_authority_check" CHECK (((
    "provider_write_started" = FALSE
      AND "state" IN ('reserved', 'delete_pending', 'deleting', 'deleted', 'quarantined')
      AND "provider_version_id" IS NULL AND "provider_etag" IS NULL
      AND "provider_checksum" IS NULL AND "upload_receipt_digest" IS NULL
  ) OR (
    "provider_write_started" = TRUE
      AND "state" IN ('uploading', 'delete_pending', 'deleting', 'quarantined')
      AND "provider_version_id" IS NULL AND "provider_etag" IS NULL
      AND "provider_checksum" IS NULL AND "upload_receipt_digest" IS NULL
  ) OR (
    "provider_write_started" = TRUE
      AND "state" IN ('present', 'verified', 'delete_pending', 'deleting', 'deleted', 'quarantined')
      AND ("provider_version_id" IS NOT NULL OR "provider_etag" IS NOT NULL
        OR "provider_checksum" IS NOT NULL)
      AND "upload_receipt_digest" ~ '^[0-9a-f]{64}$'
  )) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_objects_chunk_copy_uidx"
  ON "agent_backup_objects" ("backup_id", "component", "chunk_index", "copy_role");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_objects_immutable_locator_uidx"
  ON "agent_backup_objects" (
    "provider", "endpoint_alias", "endpoint_identity_fingerprint", "bucket", "object_key"
  );
CREATE INDEX IF NOT EXISTS "agent_backup_objects_backup_state_idx"
  ON "agent_backup_objects" ("backup_id", "copy_role", "state");

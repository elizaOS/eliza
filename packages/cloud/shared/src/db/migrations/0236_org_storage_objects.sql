CREATE TABLE IF NOT EXISTS "org_storage_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "storage_namespace" text NOT NULL DEFAULT 'attachment-r2-v1',
  "object_key" text NOT NULL,
  "key_fingerprint" text NOT NULL,
  "presence" text NOT NULL,
  "last_allocated_generation" bigint NOT NULL DEFAULT 0,
  "committed_generation" bigint NOT NULL DEFAULT 0,
  "size_bytes" bigint NOT NULL DEFAULT 0,
  "provider_version" text,
  "provider_etag" text,
  "content_type" text,
  "checksum_sha256" text,
  "provider_uploaded_at" timestamptz,
  "verified_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "org_storage_objects_tenant_identity_unique" UNIQUE ("id", "organization_id"),
  CONSTRAINT "org_storage_objects_locator_check" CHECK (
    "storage_namespace" = 'attachment-r2-v1'
    AND "object_key" LIKE 'org/' || "organization_id"::text || '/%'
    AND char_length("object_key") > char_length('org/' || "organization_id"::text || '/')
    AND octet_length("object_key") <= 1024
    AND "object_key" IS NFC NORMALIZED
    AND "object_key" !~ '[[:cntrl:]]'
    AND "object_key" !~ '(^|/)\.\.(/|$)'
    AND "key_fingerprint" ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT "org_storage_objects_generation_check" CHECK (
    "committed_generation" >= 0
    AND "last_allocated_generation" >= "committed_generation"
    AND "size_bytes" >= 0
    AND ("presence" <> 'present' OR "committed_generation" > 0)
  ),
  CONSTRAINT "org_storage_objects_presence_shape_check" CHECK (((
    "presence" = 'absent' AND "size_bytes" = 0
    AND "provider_version" IS NULL AND "provider_etag" IS NULL
    AND "content_type" IS NULL AND "checksum_sha256" IS NULL
    AND "provider_uploaded_at" IS NULL
  ) OR (
    "presence" = 'present'
    AND char_length("provider_version") BETWEEN 1 AND 1024
    AND char_length("provider_etag") BETWEEN 1 AND 512
    AND "provider_etag" !~ '["\r\n]'
    AND char_length("content_type") BETWEEN 1 AND 255
    AND "content_type" !~ '[\r\n]'
    AND ("checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$')
    AND "provider_uploaded_at" IS NOT NULL
  )) IS TRUE),
  CONSTRAINT "org_storage_objects_presence_check" CHECK ("presence" IN ('absent', 'present'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_objects_org_key_uidx"
  ON "org_storage_objects" ("organization_id", "storage_namespace", "object_key");
CREATE INDEX IF NOT EXISTS "org_storage_objects_org_presence_key_idx"
  ON "org_storage_objects" ("organization_id", "presence", "object_key");

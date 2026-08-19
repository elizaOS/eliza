-- Establishes authoritative native storage catalog and precise server-owned pricing.
ALTER TABLE "service_pricing"
  ALTER COLUMN "cost" TYPE numeric(18,12);
ALTER TABLE "service_pricing_audit"
  ALTER COLUMN "old_cost" TYPE numeric(18,12),
  ALTER COLUMN "new_cost" TYPE numeric(18,12);

ALTER TABLE "credit_transactions"
  ADD CONSTRAINT "credit_transactions_tenant_identity_unique"
  UNIQUE("id", "organization_id");

CREATE TABLE "org_storage_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "logical_key" text NOT NULL,
  "generation" bigint DEFAULT 0 NOT NULL,
  "provider_key" text,
  "size_bytes" bigint DEFAULT 0 NOT NULL,
  "content_type" text,
  "content_sha256" text,
  "etag" text,
  "uploaded_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_storage_objects_tenant_identity_unique" UNIQUE("id", "organization_id"),
  CONSTRAINT "org_storage_objects_shape_check" CHECK (
    "generation" >= 0 AND "size_bytes" >= 0 AND ((
      "generation" = 0 AND "provider_key" IS NULL AND "size_bytes" = 0
    ) OR (
      "generation" > 0 AND "provider_key" IS NOT NULL
      AND "content_sha256" ~ '^[0-9a-f]{64}$'
      AND char_length("content_type") BETWEEN 1 AND 255
      AND char_length("etag") BETWEEN 1 AND 512
      AND "uploaded_at" IS NOT NULL AND "deleted_at" IS NULL
    ) OR (
      "generation" > 0 AND "provider_key" IS NULL AND "size_bytes" = 0
      AND "deleted_at" IS NOT NULL
    ))
  )
);

CREATE UNIQUE INDEX "org_storage_objects_tenant_key_uidx"
  ON "org_storage_objects"("organization_id", "logical_key");
CREATE UNIQUE INDEX "org_storage_objects_provider_key_uidx"
  ON "org_storage_objects"("provider_key") WHERE "provider_key" IS NOT NULL;

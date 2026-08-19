-- Establishes authoritative native storage catalog and precise server-owned pricing.
ALTER TABLE "service_pricing"
  ALTER COLUMN "cost" TYPE numeric(18,12);
--> statement-breakpoint
ALTER TABLE "service_pricing_audit"
  ALTER COLUMN "old_cost" TYPE numeric(18,12),
  ALTER COLUMN "new_cost" TYPE numeric(18,12);
--> statement-breakpoint

WITH stale_price AS (
  SELECT id, service_id, method, cost
  FROM "service_pricing"
  WHERE "service_id" = 'storage' AND "method" = 'put_per_byte' AND "cost" = 0
), audit AS (
  INSERT INTO "service_pricing_audit" (
    service_pricing_id, service_id, method, old_cost, new_cost,
    change_type, changed_by, reason
  )
  SELECT id, service_id, method, cost, 0.000000001,
    'migration_reseed', 'migration:0256',
    'Restore put_per_byte after widening pricing precision'
  FROM stale_price
)
UPDATE "service_pricing" AS pricing
SET "cost" = 0.000000001, "updated_at" = NOW()
FROM stale_price
WHERE pricing.id = stale_price.id;
--> statement-breakpoint

ALTER TABLE "org_storage_quota"
  ADD COLUMN "native_catalog_reconciled_at" timestamp with time zone;
--> statement-breakpoint

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
      "generation" = 0 AND "provider_key" IS NOT NULL AND "size_bytes" > 0
      AND char_length("content_type") BETWEEN 1 AND 255
      AND char_length("etag") BETWEEN 1 AND 512
      AND "uploaded_at" IS NOT NULL AND "deleted_at" IS NULL
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
--> statement-breakpoint

CREATE UNIQUE INDEX "org_storage_objects_tenant_key_uidx"
  ON "org_storage_objects"("organization_id", "logical_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_objects_provider_key_uidx"
  ON "org_storage_objects"("provider_key") WHERE "provider_key" IS NOT NULL;

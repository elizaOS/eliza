-- Adds durable native storage mutation operations and tenant-bound credit authority.
CREATE TABLE "org_storage_put_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "object_id" uuid NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_digest" text NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "source_generation" bigint NOT NULL,
  "source_provider_key" text,
  "source_size_bytes" bigint NOT NULL,
  "target_generation" bigint NOT NULL,
  "target_provider_key" text NOT NULL,
  "target_size_bytes" bigint NOT NULL,
  "target_content_type" text NOT NULL,
  "target_content_sha256" text NOT NULL,
  "quota_reserved_bytes" bigint NOT NULL,
  "price_usd" numeric(12,6) NOT NULL,
  "credit_transaction_id" uuid,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "result_etag" text,
  "result_uploaded_at" timestamp with time zone,
  "response_json" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_storage_put_operations_object_tenant_fkey"
    FOREIGN KEY ("object_id", "organization_id")
    REFERENCES "org_storage_objects"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_put_operations_credit_tenant_fkey"
    FOREIGN KEY ("credit_transaction_id", "organization_id")
    REFERENCES "credit_transactions"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_put_operations_shape_check" CHECK (
    "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "target_content_sha256" ~ '^[0-9a-f]{64}$'
    AND "state" IN ('prepared','reserved','provider_started','committed','refunded')
    AND "source_generation" >= 0 AND "target_generation" = "source_generation" + 1
    AND "source_size_bytes" >= 0 AND "target_size_bytes" > 0
    AND "quota_reserved_bytes" = GREATEST("target_size_bytes" - "source_size_bytes", 0)
    AND "price_usd" >= 0
    AND ("state" IN ('prepared','refunded') OR "credit_transaction_id" IS NOT NULL OR "price_usd" = 0)
    AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
    AND ("state" <> 'committed' OR (
      "result_etag" IS NOT NULL AND "result_uploaded_at" IS NOT NULL
      AND "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
    ))
    AND ("state" <> 'refunded' OR (
      "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
    ))
  )
);

CREATE UNIQUE INDEX "org_storage_put_operations_idempotency_uidx"
  ON "org_storage_put_operations"("organization_id", "idempotency_key_hash");
CREATE UNIQUE INDEX "org_storage_put_operations_provider_key_uidx"
  ON "org_storage_put_operations"("target_provider_key");
CREATE UNIQUE INDEX "org_storage_put_operations_active_object_uidx"
  ON "org_storage_put_operations"("object_id")
  WHERE "state" IN ('prepared','reserved','provider_started');
CREATE INDEX "org_storage_put_operations_due_idx"
  ON "org_storage_put_operations"("state", "lease_expires_at");

CREATE TABLE "org_storage_delete_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "object_id" uuid NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_digest" text NOT NULL,
  "state" text DEFAULT 'prepared' NOT NULL,
  "source_generation" bigint NOT NULL,
  "source_provider_key" text NOT NULL,
  "source_size_bytes" bigint NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "response_json" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_storage_delete_operations_object_tenant_fkey"
    FOREIGN KEY ("object_id", "organization_id")
    REFERENCES "org_storage_objects"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_delete_operations_shape_check" CHECK (
    "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "state" IN ('prepared','provider_started','committed')
    AND "source_generation" > 0 AND "source_size_bytes" > 0
    AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
    AND ("state" <> 'committed' OR (
      "response_json" IS NOT NULL AND "completed_at" IS NOT NULL AND "lease_token" IS NULL
    ))
  )
);
CREATE UNIQUE INDEX "org_storage_delete_operations_idempotency_uidx"
  ON "org_storage_delete_operations"("organization_id", "idempotency_key_hash");
CREATE UNIQUE INDEX "org_storage_delete_operations_active_object_uidx"
  ON "org_storage_delete_operations"("object_id")
  WHERE "state" IN ('prepared','provider_started');
CREATE INDEX "org_storage_delete_operations_due_idx"
  ON "org_storage_delete_operations"("state", "lease_expires_at");

-- Adds durable native storage mutation operations and tenant-bound credit authority.
CREATE FUNCTION "org_storage_credit_matches_tenant"(uuid, uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL UNSAFE
AS 'SELECT $1 IS NULL OR EXISTS (
  SELECT 1 FROM credit_transactions
  WHERE id = $1 AND organization_id = $2
)';
--> statement-breakpoint

CREATE FUNCTION "credit_transaction_tenant_is_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'credit transaction tenant provenance is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "credit_transactions_tenant_immutable"
BEFORE UPDATE OF "organization_id" ON "credit_transactions"
FOR EACH ROW
EXECUTE FUNCTION "credit_transaction_tenant_is_immutable"();
--> statement-breakpoint

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
  "provider_absence_observed_at" timestamp with time zone,
  "result_etag" text,
  "result_uploaded_at" timestamp with time zone,
  "response_json" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_storage_put_operations_object_tenant_fkey"
    FOREIGN KEY ("object_id", "organization_id")
    REFERENCES "org_storage_objects"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_put_operations_credit_fkey"
    FOREIGN KEY ("credit_transaction_id")
    REFERENCES "credit_transactions"("id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_put_operations_credit_tenant_check"
    CHECK ("org_storage_credit_matches_tenant"("credit_transaction_id", "organization_id")),
  CONSTRAINT "org_storage_put_operations_shape_check" CHECK (
    "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    AND "request_digest" ~ '^[0-9a-f]{64}$'
    AND "target_content_sha256" ~ '^[0-9a-f]{64}$'
    AND "state" IN ('prepared','reserved','provider_started','reconciling','committed','refunded')
    AND "source_generation" >= 0 AND "target_generation" = "source_generation" + 1
    AND "source_size_bytes" >= 0 AND "target_size_bytes" > 0
    AND "quota_reserved_bytes" = GREATEST("target_size_bytes" - "source_size_bytes", 0)
    AND "price_usd" >= 0
    AND ("state" IN ('prepared','reconciling','refunded') OR "credit_transaction_id" IS NOT NULL OR "price_usd" = 0)
    AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
    AND ("state" <> 'reconciling' OR "lease_token" IS NOT NULL)
    AND ("provider_absence_observed_at" IS NULL OR "state" = 'reconciling')
    AND ("state" <> 'committed' OR (
      "result_etag" IS NOT NULL AND "result_uploaded_at" IS NOT NULL
      AND "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
    ))
    AND ("state" <> 'refunded' OR (
      "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
    ))
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "org_storage_put_operations_idempotency_uidx"
  ON "org_storage_put_operations"("organization_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_put_operations_provider_key_uidx"
  ON "org_storage_put_operations"("target_provider_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_put_operations_active_object_uidx"
  ON "org_storage_put_operations"("object_id")
  WHERE "state" IN ('prepared','reserved','provider_started','reconciling');
--> statement-breakpoint
CREATE INDEX "org_storage_put_operations_due_idx"
  ON "org_storage_put_operations"("state", "lease_expires_at");
--> statement-breakpoint

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
    AND "source_generation" >= 0 AND "source_size_bytes" > 0
    AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
    AND ("state" <> 'committed' OR (
      "response_json" IS NOT NULL AND "completed_at" IS NOT NULL AND "lease_token" IS NULL
    ))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_delete_operations_idempotency_uidx"
  ON "org_storage_delete_operations"("organization_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_delete_operations_active_object_uidx"
  ON "org_storage_delete_operations"("object_id")
  WHERE "state" IN ('prepared','provider_started');
--> statement-breakpoint
CREATE INDEX "org_storage_delete_operations_due_idx"
  ON "org_storage_delete_operations"("state", "lease_expires_at");

CREATE TABLE IF NOT EXISTS "org_storage_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "object_id" uuid NOT NULL, "operation" text NOT NULL, "state" text NOT NULL DEFAULT 'prepared',
  "idempotency_key_hash" text NOT NULL, "request_digest" text NOT NULL,
  "source_presence" text NOT NULL, "source_generation" bigint NOT NULL,
  "target_generation" bigint NOT NULL, "source_size_bytes" bigint NOT NULL,
  "target_size_bytes" bigint NOT NULL, "quota_delta_bytes" bigint NOT NULL,
  "quota_reserved_bytes" bigint NOT NULL, "quota_release_bytes" bigint NOT NULL,
  "source_provider_version" text, "source_provider_etag" text,
  "target_content_type" text, "target_content_sha256" text,
  "provider_write_started" boolean NOT NULL DEFAULT FALSE, "provider_started_at" timestamptz,
  "result_provider_version" text, "result_provider_etag" text, "result_size_bytes" bigint,
  "result_checksum_sha256" text, "result_uploaded_at" timestamptz, "response_status" smallint,
  "receipt_digest" text, "claim_owner" text, "claim_generation" uuid,
  "lease_expires_at" timestamptz, "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT NOW(), "last_observed_at" timestamptz,
  "last_error_code" text, "last_error_digest" text, "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(), "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "org_storage_operations_object_tenant_fkey" FOREIGN KEY ("object_id", "organization_id")
    REFERENCES "org_storage_objects"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "org_storage_operations_identity_check" CHECK (
    "operation" IN ('put', 'delete')
    AND "state" IN ('prepared', 'provider_started', 'committed', 'aborted', 'quarantined')
    AND "idempotency_key_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "request_digest" ~ '^sha256:[0-9a-f]{64}$' AND "attempts" >= 0
  ),
  CONSTRAINT "org_storage_operations_generation_check" CHECK (
    "source_generation" >= 0 AND "target_generation" > "source_generation"
    AND "source_size_bytes" >= 0 AND "target_size_bytes" >= 0
  ),
  CONSTRAINT "org_storage_operations_source_shape_check" CHECK (((
    "source_presence" = 'absent' AND "source_size_bytes" = 0
    AND "source_provider_version" IS NULL AND "source_provider_etag" IS NULL
  ) OR (
    "source_presence" = 'present' AND "source_generation" > 0 AND char_length("source_provider_version") BETWEEN 1 AND 1024
    AND char_length("source_provider_etag") BETWEEN 1 AND 512
    AND "source_provider_etag" !~ '["\r\n]'
  )) IS TRUE),
  CONSTRAINT "org_storage_operations_target_shape_check" CHECK (((
    "operation" = 'put' AND char_length("target_content_type") BETWEEN 1 AND 255
    AND "target_content_type" !~ '[\r\n]' AND "target_content_sha256" ~ '^[0-9a-f]{64}$'
  ) OR ("operation" = 'delete' AND "target_size_bytes" = 0
    AND "target_content_type" IS NULL AND "target_content_sha256" IS NULL)) IS TRUE),
  CONSTRAINT "org_storage_operations_quota_shape_check" CHECK (
    "quota_delta_bytes" = "target_size_bytes" - "source_size_bytes" AND "quota_delta_bytes" = "quota_reserved_bytes" - "quota_release_bytes"
    AND "quota_reserved_bytes" = CASE WHEN "operation" = 'put' THEN "target_size_bytes" ELSE 0 END
    AND "quota_release_bytes" = "source_size_bytes"
  ),
  CONSTRAINT "org_storage_operations_provider_state_check" CHECK (
    "provider_write_started" = ("provider_started_at" IS NOT NULL)
    AND ("state" NOT IN ('prepared', 'aborted') OR "provider_write_started" = FALSE)
    AND ("state" NOT IN ('provider_started', 'committed', 'quarantined')
      OR "provider_write_started" = TRUE)
    AND ("last_observed_at" IS NULL OR "provider_write_started" = TRUE)
  ),
  CONSTRAINT "org_storage_operations_claim_shape_check" CHECK ((
    (("claim_owner" IS NULL AND "claim_generation" IS NULL AND "lease_expires_at" IS NULL)
      OR ("claim_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND "claim_generation" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    AND ("state" NOT IN ('committed', 'aborted', 'quarantined')
      OR ("claim_owner" IS NULL AND "claim_generation" IS NULL AND "lease_expires_at" IS NULL))
  ) IS TRUE),
  CONSTRAINT "org_storage_operations_error_shape_check" CHECK ((
    (("last_error_code" IS NULL AND "last_error_digest" IS NULL)
      OR ("last_error_code" ~ '^[A-Z][A-Z0-9_]{0,95}$'
        AND "last_error_digest" ~ '^[0-9a-f]{64}$'))
    AND ("state" <> 'quarantined' OR "last_error_code" IS NOT NULL)
  ) IS TRUE),
  CONSTRAINT "org_storage_operations_terminal_shape_check" CHECK (((
    "state" IN ('committed', 'aborted') AND "completed_at" IS NOT NULL
    AND "receipt_digest" ~ '^[0-9a-f]{64}$' AND "response_status" IS NOT NULL
    AND ("state" <> 'aborted' OR ("response_status" BETWEEN 400 AND 599
      AND "last_error_code" IS NOT NULL AND "provider_write_started" = FALSE))
  ) OR ("state" NOT IN ('committed', 'aborted') AND "completed_at" IS NULL
    AND "receipt_digest" IS NULL AND "response_status" IS NULL)) IS TRUE),
  CONSTRAINT "org_storage_operations_result_shape_check" CHECK (((
    "state" = 'committed' AND "operation" = 'put' AND "response_status" = 201
    AND char_length("result_provider_version") BETWEEN 1 AND 1024 AND ("source_presence" <> 'present' OR "result_provider_version" <> "source_provider_version")
    AND char_length("result_provider_etag") BETWEEN 1 AND 512
    AND "result_provider_etag" !~ '["\r\n]' AND "result_size_bytes" = "target_size_bytes"
    AND "result_checksum_sha256" = "target_content_sha256" AND "result_uploaded_at" IS NOT NULL
  ) OR ("state" = 'committed' AND "operation" = 'delete' AND "response_status" = 204
    AND "result_provider_version" IS NULL AND "result_provider_etag" IS NULL
    AND "result_size_bytes" IS NULL AND "result_checksum_sha256" IS NULL
    AND "result_uploaded_at" IS NULL) OR ("state" <> 'committed'
    AND "result_provider_version" IS NULL AND "result_provider_etag" IS NULL
    AND "result_size_bytes" IS NULL AND "result_checksum_sha256" IS NULL
    AND "result_uploaded_at" IS NULL)) IS TRUE
  ));
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_operations_idempotency_uidx" ON "org_storage_operations" ("organization_id", "idempotency_key_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_operations_generation_uidx" ON "org_storage_operations" ("object_id", "target_generation");
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_operations_active_object_uidx"
  ON "org_storage_operations" ("object_id") WHERE "state" IN ('prepared', 'provider_started', 'quarantined');
CREATE INDEX IF NOT EXISTS "org_storage_operations_due_idx"
  ON "org_storage_operations" ("next_attempt_at", "created_at") WHERE "state" IN ('prepared', 'provider_started');
CREATE INDEX IF NOT EXISTS "org_storage_operations_org_state_idx"
  ON "org_storage_operations" ("organization_id", "state", "updated_at");

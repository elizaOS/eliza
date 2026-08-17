CREATE TABLE IF NOT EXISTS "org_storage_head_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "authority_version" smallint NOT NULL DEFAULT 1,
  "storage_namespace" text NOT NULL DEFAULT 'attachment-r2-v1',
  "operation" text NOT NULL DEFAULT 'head',
  "idempotency_key_hash" text NOT NULL,
  "request_digest" text NOT NULL,
  "charge_amount_usd" numeric(12, 6) NOT NULL,
  "response_kind" text NOT NULL,
  "response_status" smallint NOT NULL,
  "header_policy_version" smallint NOT NULL DEFAULT 1,
  "object_id" uuid,
  "object_generation" bigint,
  "response_content_length" bigint,
  "response_content_type" text,
  "response_etag" text,
  "response_last_modified" timestamptz,
  "response_force_attachment" boolean,
  "credit_transaction_id" uuid,
  "receipt_digest" text NOT NULL,
  "replay_expires_at" timestamptz NOT NULL,
  "purge_after" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "org_storage_head_receipts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "org_storage_head_receipts_credit_transaction_id_fkey"
    FOREIGN KEY ("credit_transaction_id") REFERENCES "credit_transactions"("id")
    ON DELETE NO ACTION,
  CONSTRAINT "org_storage_head_receipts_identity_check" CHECK ((
    "authority_version" = 1 AND "storage_namespace" = 'attachment-r2-v1'
    AND "operation" = 'head' AND "header_policy_version" = 1
    AND "idempotency_key_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "request_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "receipt_digest" ~ '^[0-9a-f]{64}$'
  ) IS TRUE),
  CONSTRAINT "org_storage_head_receipts_charge_shape_check" CHECK ((
    "charge_amount_usd" <> 'NaN'::numeric
    AND "charge_amount_usd" <= 999999.999999 AND (
      ("charge_amount_usd" = 0 AND "credit_transaction_id" IS NULL)
      OR ("charge_amount_usd" > 0 AND "credit_transaction_id" IS NOT NULL)
    )
  ) IS TRUE),
  CONSTRAINT "org_storage_head_receipts_retention_check" CHECK ((
    isfinite("created_at") AND isfinite("replay_expires_at") AND isfinite("purge_after")
    AND "created_at" < "replay_expires_at" AND "replay_expires_at" < "purge_after"
  ) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_head_receipts_idempotency_uidx"
  ON "org_storage_head_receipts" ("organization_id", "idempotency_key_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_head_receipts_credit_transaction_uidx"
  ON "org_storage_head_receipts" ("credit_transaction_id")
  WHERE "credit_transaction_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "org_storage_head_receipts_purge_idx"
  ON "org_storage_head_receipts" ("purge_after", "id");
CREATE INDEX IF NOT EXISTS "org_storage_head_receipts_org_object_generation_idx"
  ON "org_storage_head_receipts" ("organization_id", "object_id", "object_generation")
  WHERE "object_id" IS NOT NULL;

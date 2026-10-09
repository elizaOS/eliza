-- Lets allowance-first subscription funding reservations carry native storage charges.
ALTER TABLE "org_storage_put_operations" ADD COLUMN "funding_reservation_id" uuid;
--> statement-breakpoint
ALTER TABLE "org_storage_put_operations"
  ADD CONSTRAINT "org_storage_put_operations_funding_reservation_fkey"
  FOREIGN KEY ("funding_reservation_id", "organization_id")
  REFERENCES "billing_funding_reservations"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_put_operations_funding_reservation_uidx"
  ON "org_storage_put_operations"("funding_reservation_id")
  WHERE "funding_reservation_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_storage_put_operations" DROP CONSTRAINT "org_storage_put_operations_shape_check";
--> statement-breakpoint
ALTER TABLE "org_storage_put_operations" ADD CONSTRAINT "org_storage_put_operations_shape_check" CHECK (
  "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
  AND "request_digest" ~ '^[0-9a-f]{64}$'
  AND "target_content_sha256" ~ '^[0-9a-f]{64}$'
  AND "state" IN ('prepared','reserved','provider_started','reconciling','committed','refunded')
  AND "source_generation" >= 0 AND "target_generation" = "source_generation" + 1
  AND "source_size_bytes" >= 0 AND "target_size_bytes" > 0
  AND "quota_reserved_bytes" = GREATEST("target_size_bytes" - "source_size_bytes", 0)
  AND "price_usd" >= 0
  AND ("credit_transaction_id" IS NULL OR "funding_reservation_id" IS NULL)
  AND ("funding_reservation_id" IS NULL OR "price_usd" > 0)
  AND ("state" IN ('prepared','reconciling','refunded') OR "price_usd" = 0
    OR "credit_transaction_id" IS NOT NULL OR "funding_reservation_id" IS NOT NULL)
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
);
--> statement-breakpoint
ALTER TABLE "org_storage_read_operations" ADD COLUMN "funding_reservation_id" uuid;
--> statement-breakpoint
ALTER TABLE "org_storage_read_operations"
  ADD CONSTRAINT "org_storage_read_operations_funding_reservation_fkey"
  FOREIGN KEY ("funding_reservation_id", "organization_id")
  REFERENCES "billing_funding_reservations"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "org_storage_read_operations_funding_reservation_uidx"
  ON "org_storage_read_operations"("funding_reservation_id")
  WHERE "funding_reservation_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_storage_read_operations" DROP CONSTRAINT "org_storage_read_operations_shape_check";
--> statement-breakpoint
ALTER TABLE "org_storage_read_operations" ADD CONSTRAINT "org_storage_read_operations_shape_check" CHECK (
  "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
  AND "request_digest" ~ '^[0-9a-f]{64}$'
  AND "renewal_generation" >= 0
  AND (("renewal_root_id" IS NULL AND "renewal_generation" = 0)
    OR ("renewal_root_id" IS NOT NULL AND "renewal_generation" > 0
      AND "method" = 'presign'))
  AND "method" IN ('get','head','list','presign')
  AND "state" IN ('prepared','provider_succeeded','committed','failed')
  AND "price_usd" >= 0 AND "access_count" >= 0
  AND ("state" <> 'prepared' OR (
    "object_generation" IS NULL AND "provider_key" IS NULL
    AND "result_size_bytes" IS NULL AND "result_content_type" IS NULL
    AND "result_etag" IS NULL AND "response_status" IS NULL
    AND "response_json" IS NULL AND "provider_succeeded_at" IS NULL
    AND "completed_at" IS NULL AND "credit_transaction_id" IS NULL
    AND "funding_reservation_id" IS NULL
    AND "last_access_at" IS NULL AND "access_count" = 0
  ))
  AND ("state" = 'prepared' OR ("response_status" IS NOT NULL AND "response_json" IS NOT NULL))
  AND ("state" NOT IN ('provider_succeeded','committed') OR "provider_succeeded_at" IS NOT NULL)
  AND ("state" NOT IN ('committed','failed') OR "completed_at" IS NOT NULL)
  AND ("state" <> 'provider_succeeded' OR (
    "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL
    AND "completed_at" IS NULL
  ))
  AND ("state" = 'committed' OR (
    "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL
    AND "last_access_at" IS NULL AND "access_count" = 0
  ))
  AND ("state" <> 'committed' OR (
    ("price_usd" = 0 AND "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL)
    OR ("price_usd" > 0 AND (
      ("credit_transaction_id" IS NOT NULL AND "funding_reservation_id" IS NULL)
      OR ("credit_transaction_id" IS NULL AND "funding_reservation_id" IS NOT NULL)
    ))
  ))
  AND ("method" = 'list' OR "state" IN ('prepared','failed') OR "object_id" IS NOT NULL)
  AND ("provider_key" IS NULL OR "object_generation" IS NOT NULL)
  AND (("capability_id" IS NULL AND "capability_host" IS NULL
    AND "capability_issued_at" IS NULL AND "capability_expires_at" IS NULL)
    OR ("method" = 'presign' AND "capability_id" IS NOT NULL
      AND "capability_host" IS NOT NULL AND "capability_issued_at" IS NOT NULL
      AND "capability_expires_at" > "capability_issued_at"))
  AND ("capability_revoked_at" IS NULL OR "capability_id" IS NOT NULL)
  AND ("last_access_at" IS NULL OR "access_count" > 0)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "org_storage_read_insert_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'prepared' THEN
    RAISE EXCEPTION 'storage read must start prepared' USING ERRCODE = '23514';
  END IF;
  IF NEW.object_generation IS NOT NULL OR NEW.provider_key IS NOT NULL
      OR NEW.result_size_bytes IS NOT NULL OR NEW.result_content_type IS NOT NULL
      OR NEW.result_etag IS NOT NULL OR NEW.response_status IS NOT NULL
      OR NEW.response_json IS NOT NULL OR NEW.credit_transaction_id IS NOT NULL
      OR NEW.funding_reservation_id IS NOT NULL
      OR NEW.provider_succeeded_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.capability_revoked_at IS NOT NULL OR NEW.last_access_at IS NOT NULL
      OR NEW.access_count <> 0 THEN
    RAISE EXCEPTION 'storage read birth result authority must be empty'
      USING ERRCODE = '23514';
  END IF;
  -- Serialize request creation against tenant reassignment. The user row is
  -- always locked before the read receipt exists, while later settlement only
  -- locks the immutable receipt and organization ledger.
  PERFORM 1 FROM users
    WHERE id = NEW.user_id AND organization_id = NEW.organization_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage read actor tenant mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.renewal_root_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org_storage_read_operations root
    WHERE root.id = NEW.renewal_root_id
      AND root.organization_id = NEW.organization_id
      AND root.user_id = NEW.user_id
      AND root.method = 'presign'
      AND root.renewal_root_id IS NULL
      AND root.renewal_generation = 0
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'storage read renewal root mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "org_storage_read_operation_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.user_id, NEW.idempotency_key_hash,
      NEW.request_digest, NEW.renewal_root_id, NEW.renewal_generation,
      NEW.method, NEW.price_usd,
      NEW.capability_id, NEW.capability_host, NEW.capability_issued_at,
      NEW.capability_expires_at, NEW.retain_until)
    IS DISTINCT FROM
    ROW(OLD.organization_id, OLD.user_id, OLD.idempotency_key_hash,
      OLD.request_digest, OLD.renewal_root_id, OLD.renewal_generation,
      OLD.method, OLD.price_usd,
      OLD.capability_id, OLD.capability_host, OLD.capability_issued_at,
      OLD.capability_expires_at, OLD.retain_until) THEN
    RAISE EXCEPTION 'storage read request authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> NEW.state AND NOT (
    (OLD.state = 'prepared' AND NEW.state IN ('provider_succeeded','failed'))
    OR (OLD.state = 'provider_succeeded' AND NEW.state IN ('committed','failed'))
  ) THEN
    RAISE EXCEPTION 'invalid storage read state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'committed'
        AND NEW.price_usd > 0 AND NEW.credit_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'storage read debit attaches only at paid commit' USING ERRCODE = '23514';
  END IF;
  IF NEW.funding_reservation_id IS DISTINCT FROM OLD.funding_reservation_id
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'committed'
        AND NEW.price_usd > 0 AND NEW.funding_reservation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'storage read funding attaches only at paid commit' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'prepared' AND ROW(NEW.object_id, NEW.object_generation,
      NEW.provider_key, NEW.result_size_bytes, NEW.result_content_type,
      NEW.result_etag, NEW.provider_succeeded_at)
    IS DISTINCT FROM
    ROW(OLD.object_id, OLD.object_generation, OLD.provider_key,
      OLD.result_size_bytes, OLD.result_content_type, OLD.result_etag,
      OLD.provider_succeeded_at) THEN
    RAISE EXCEPTION 'storage read result authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'prepared'
      AND ROW(NEW.response_status, NEW.response_json) IS DISTINCT FROM
        ROW(OLD.response_status, OLD.response_json)
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'failed'
        AND ((NEW.response_status = 402
          AND NEW.response_json = '{"error":"Insufficient credits"}')
          OR (OLD.method = 'presign' AND NEW.response_status = 409
            AND NEW.response_json IN ('{"error":"Capability expired before settlement"}',
              '{"error":"Capability revoked before settlement"}')))) THEN
    RAISE EXCEPTION 'storage read response authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('committed','failed') AND ROW(NEW.response_status,
      NEW.response_json, NEW.credit_transaction_id, NEW.funding_reservation_id,
      NEW.completed_at)
    IS DISTINCT FROM ROW(OLD.response_status, OLD.response_json,
      OLD.credit_transaction_id, OLD.funding_reservation_id, OLD.completed_at) THEN
    RAISE EXCEPTION 'terminal storage read receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.capability_revoked_at IS NOT NULL
      AND NEW.capability_revoked_at IS DISTINCT FROM OLD.capability_revoked_at THEN
    RAISE EXCEPTION 'storage read revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.credit_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM credit_transactions c
    WHERE c.id = NEW.credit_transaction_id
      AND c.organization_id = NEW.organization_id AND c.user_id = NEW.user_id
      AND c.type = 'debit' AND c.amount = -NEW.price_usd AND c.settled_at IS NOT NULL
      AND c.metadata->>'settlement_marker' = 'storage_read_receipt_v2'
      AND c.metadata->>'storage_read_operation_id' = NEW.id::text
      AND c.metadata->>'request_digest' = NEW.request_digest
      AND c.metadata->>'method' = NEW.method
      AND c.metadata->>'price_usd' = NEW.price_usd::text
  ) THEN
    RAISE EXCEPTION 'storage read credit authority mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.funding_reservation_id IS NOT NULL
      AND NEW.funding_reservation_id IS DISTINCT FROM OLD.funding_reservation_id
      AND NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations r
    WHERE r.id = NEW.funding_reservation_id
      AND r.organization_id = NEW.organization_id
      AND r.logical_operation_id = 'storage.read:' || NEW.id::text
      AND r.funding_class = 'allowance_eligible'
      AND r.status = 'finalized'
      AND r.requested_amount = NEW.price_usd
  ) THEN
    RAISE EXCEPTION 'storage read funding authority mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

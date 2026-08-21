ALTER TABLE "domain_purchase_idempotency"
  ADD COLUMN IF NOT EXISTS "request_digest" text,
  ADD COLUMN IF NOT EXISTS "registration_years" integer,
  ADD COLUMN IF NOT EXISTS "refund_id" uuid,
  ADD COLUMN IF NOT EXISTS "response_status" integer,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "provider_started_at" timestamp,
  ADD COLUMN IF NOT EXISTS "next_reconcile_at" timestamp,
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_charge_fk"
  FOREIGN KEY ("charge_id") REFERENCES "credit_transactions"("id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_charge_fk";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_refund_fk"
  FOREIGN KEY ("refund_id") REFERENCES "credit_transactions"("id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_refund_fk";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_managed_domain_fk"
  FOREIGN KEY ("managed_domain_id") REFERENCES "managed_domains"("id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_managed_domain_fk";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_status_check"
  CHECK ("status" IN (
    'processing', 'quoted', 'charged', 'provider_started',
    'provider_ambiguous', 'registered', 'completed',
    'refund_pending', 'refunded', 'failed'
  )) NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_status_check";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_attempt_count_check"
  CHECK ("attempt_count" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_attempt_count_check";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_registration_years_check"
  CHECK (
    ("request_digest" IS NULL AND "registration_years" IS NULL)
    OR (
      "request_digest" IS NOT NULL
      AND "registration_years" IS NOT NULL
      AND "registration_years" BETWEEN 1 AND 10
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_registration_years_check";
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  ADD CONSTRAINT "domain_purchase_idempotency_phase_shape_check"
  CHECK (
    "request_digest" IS NULL
    OR (
      ("status" = 'processing' AND "charge" IS NULL AND "charge_id" IS NULL)
      OR ("status" = 'quoted' AND "charge" IS NOT NULL AND "charge_id" IS NULL)
      OR ("status" IN ('charged','provider_started','provider_ambiguous','registered')
        AND "charge" IS NOT NULL AND "charge_id" IS NOT NULL AND "refund_id" IS NULL)
      OR ("status" = 'refund_pending'
        AND "charge" IS NOT NULL AND "charge_id" IS NOT NULL AND "refund_id" IS NULL)
      OR ("status" = 'refunded'
        AND "charge" IS NOT NULL AND "charge_id" IS NOT NULL AND "refund_id" IS NOT NULL
        AND "response_body" IS NOT NULL AND "response_status" IS NOT NULL)
      OR ("status" = 'failed' AND "charge_id" IS NULL
        AND "response_body" IS NOT NULL AND "response_status" IS NOT NULL)
      OR ("status" = 'completed' AND "managed_domain_id" IS NOT NULL
        AND "response_body" IS NOT NULL AND "response_status" IS NOT NULL)
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "domain_purchase_idempotency"
  VALIDATE CONSTRAINT "domain_purchase_idempotency_phase_shape_check";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_purchase_idempotency_reconcile_idx"
  ON "domain_purchase_idempotency" ("status", "next_reconcile_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION domain_purchase_attempt_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  charge_row "credit_transactions"%ROWTYPE;
  refund_row "credit_transactions"%ROWTYPE;
  managed_org uuid;
  managed_name text;
BEGIN
  IF NEW."key" IS DISTINCT FROM ('domain-buy:' || NEW."organization_id"::text || ':' || NEW."domain") THEN
    RAISE EXCEPTION 'domain purchase key binding mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "apps"
    WHERE "id" = NEW."app_id" AND "organization_id" = NEW."organization_id"
  ) THEN
    RAISE EXCEPTION 'domain purchase app tenant binding mismatch';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
    OR NEW."domain" IS DISTINCT FROM OLD."domain"
    OR (OLD."request_digest" IS NOT NULL
      AND NEW."request_digest" IS DISTINCT FROM OLD."request_digest")
    OR (OLD."registration_years" IS NOT NULL
      AND NEW."registration_years" IS DISTINCT FROM OLD."registration_years")
    OR (OLD."charge" IS NOT NULL AND NEW."charge" IS DISTINCT FROM OLD."charge")
    OR (OLD."charge_id" IS NOT NULL AND NEW."charge_id" IS DISTINCT FROM OLD."charge_id")
    OR (OLD."refund_id" IS NOT NULL AND NEW."refund_id" IS DISTINCT FROM OLD."refund_id")
  ) THEN
    RAISE EXCEPTION 'domain purchase immutable binding changed';
  END IF;

  IF NEW."request_digest" IS NOT NULL AND NEW."request_digest" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'domain purchase request digest is invalid';
  END IF;

  IF NEW."request_digest" IS NOT NULL
    AND NEW."charge" IS NOT NULL
    AND NEW."charge"->>'years' IS DISTINCT FROM NEW."registration_years"::text
  THEN
    RAISE EXCEPTION 'domain purchase quote term binding mismatch';
  END IF;

  IF NEW."charge_id" IS NOT NULL THEN
    SELECT * INTO charge_row FROM "credit_transactions" WHERE "id" = NEW."charge_id";
    IF NEW."charge" IS NULL
      OR NOT FOUND
      OR charge_row."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR charge_row."type" IS DISTINCT FROM 'debit'
      OR charge_row."amount" IS DISTINCT FROM -((NEW."charge"->>'totalUsdCents')::numeric / 100)
      OR charge_row."stripe_payment_intent_id" IS DISTINCT FROM
        'domain-purchase:' || NEW."organization_id"::text || ':' || NEW."domain"
      OR charge_row."metadata"->>'type' IS DISTINCT FROM 'domain_purchase'
      OR charge_row."metadata"->>'domain' IS DISTINCT FROM NEW."domain"
      OR charge_row."metadata"->>'domainPurchaseKey' IS DISTINCT FROM NEW."key"
    THEN
      RAISE EXCEPTION 'domain purchase charge binding mismatch';
    END IF;
  END IF;

  IF NEW."refund_id" IS NOT NULL THEN
    SELECT * INTO refund_row FROM "credit_transactions" WHERE "id" = NEW."refund_id";
    IF NEW."charge" IS NULL
      OR NOT FOUND
      OR refund_row."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR refund_row."type" IS DISTINCT FROM 'refund'
      OR refund_row."amount" IS DISTINCT FROM ((NEW."charge"->>'totalUsdCents')::numeric / 100)
      OR refund_row."stripe_payment_intent_id" IS DISTINCT FROM
        'domain-purchase-refund:' || NEW."organization_id"::text || ':' || NEW."domain"
      OR refund_row."metadata"->>'type' IS DISTINCT FROM 'domain_purchase_refund'
      OR refund_row."metadata"->>'domain' IS DISTINCT FROM NEW."domain"
      OR refund_row."metadata"->>'domainPurchaseKey' IS DISTINCT FROM NEW."key"
    THEN
      RAISE EXCEPTION 'domain purchase refund binding mismatch';
    END IF;
  END IF;

  IF NEW."managed_domain_id" IS NOT NULL THEN
    SELECT "organization_id", "domain" INTO managed_org, managed_name
    FROM "managed_domains" WHERE "id" = NEW."managed_domain_id";
    IF managed_org IS DISTINCT FROM NEW."organization_id"
      OR managed_name IS DISTINCT FROM NEW."domain"
    THEN
      RAISE EXCEPTION 'domain purchase managed-domain tenant/domain binding mismatch';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "domain_purchase_attempt_binding_guard"
  ON "domain_purchase_idempotency";
--> statement-breakpoint
CREATE TRIGGER "domain_purchase_attempt_binding_guard"
  BEFORE INSERT OR UPDATE ON "domain_purchase_idempotency"
  FOR EACH ROW EXECUTE FUNCTION domain_purchase_attempt_binding_guard();

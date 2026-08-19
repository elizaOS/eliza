-- Provisional: reserves durable tenant authority for Stripe Customer creation and reconciliation.

CREATE TABLE IF NOT EXISTS "stripe_customer_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "generation" integer NOT NULL,
  "request_digest" text NOT NULL,
  "caller_intent" text NOT NULL,
  "provider" text NOT NULL DEFAULT 'stripe',
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'prepared',
  "provider_customer_id" text,
  "provider_receipt" jsonb,
  "provider_started_at" timestamptz,
  "bound_at" timestamptz,
  "lease_token" uuid,
  "lease_expires_at" timestamptz,
  "ambiguous_reason" text,
  "provider_livemode" boolean,
  "resolved_by" text,
  "resolution_reason" text,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_customer_attempts_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "stripe_customer_attempts_digest_check" CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stripe_customer_attempts_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "stripe_customer_attempts_caller_intent_check" CHECK ("caller_intent" IN
    ('payment_method','interactive_checkout','credit_checkout')),
  CONSTRAINT "stripe_customer_attempts_status_check" CHECK ("status" IN
    ('prepared','provider_started','provider_ambiguous','bound','quarantined','abandoned')),
  CONSTRAINT "stripe_customer_attempts_bound_shape_check" CHECK (
    ("status" = 'bound' AND "provider_customer_id" IS NOT NULL
      AND "provider_receipt" IS NOT NULL AND "provider_livemode" IS NOT NULL
      AND "bound_at" IS NOT NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    OR ("status" <> 'bound' AND "provider_customer_id" IS NULL
      AND "provider_receipt" IS NULL AND "provider_livemode" IS NULL AND "bound_at" IS NULL)),
  CONSTRAINT "stripe_customer_attempts_progress_shape_check" CHECK (
    ("status" = 'prepared' AND "provider_started_at" IS NULL)
    OR ("status" <> 'prepared' AND "provider_started_at" IS NOT NULL)),
  CONSTRAINT "stripe_customer_attempts_resolution_shape_check" CHECK (
    ("status" = 'abandoned' AND "resolved_by" IS NOT NULL
      AND "resolution_reason" IS NOT NULL AND "resolved_at" IS NOT NULL)
    OR "status" <> 'abandoned')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customer_attempts_org_generation_idx"
  ON "stripe_customer_attempts" ("organization_id", "generation");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customer_attempts_idempotency_key_idx"
  ON "stripe_customer_attempts" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customer_attempts_provider_customer_idx"
  ON "stripe_customer_attempts" ("provider_customer_id")
  WHERE "provider_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customer_attempts_active_org_idx"
  ON "stripe_customer_attempts" ("organization_id")
  WHERE "status" IN ('prepared','provider_started','provider_ambiguous','bound');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_customer_attempts_status_lease_idx"
  ON "stripe_customer_attempts" ("status", "lease_expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_customer_legacy_quarantines" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "stripe_customer_id" text NOT NULL UNIQUE,
  "reason" text NOT NULL DEFAULT 'pre-authority Stripe Customer requires provider verification',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_attempt_id" uuid,
  "resolved_by" text,
  "resolution_reason" text,
  "resolved_at" timestamptz,
  CONSTRAINT "stripe_customer_legacy_quarantine_resolution_shape" CHECK (
    ("resolved_attempt_id" IS NULL AND "resolved_by" IS NULL
      AND "resolution_reason" IS NULL AND "resolved_at" IS NULL)
    OR ("resolved_attempt_id" IS NOT NULL AND "resolved_by" IS NOT NULL
      AND "resolution_reason" IS NOT NULL AND "resolved_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "stripe_customer_legacy_quarantines" q JOIN "organizations" o
      ON o."id" = q."organization_id"
      WHERE o."stripe_customer_id" IS DISTINCT FROM q."stripe_customer_id"
  ) THEN RAISE EXCEPTION 'Legacy Stripe Customer quarantine conflicts with canonical organization'; END IF;
END $$;
--> statement-breakpoint
INSERT INTO "stripe_customer_legacy_quarantines" ("organization_id", "stripe_customer_id")
SELECT "id", "stripe_customer_id" FROM "organizations" WHERE "stripe_customer_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "stripe_customer_attempts" a
      WHERE a."organization_id" = "organizations"."id" AND a."status" = 'bound'
        AND a."provider_customer_id" = "organizations"."stripe_customer_id"
  )
ON CONFLICT ("organization_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_stripe_customer_legacy_quarantine"() RETURNS trigger AS $$ BEGIN
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."stripe_customer_id" IS DISTINCT FROM OLD."stripe_customer_id"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."resolved_attempt_id" IS NOT NULL AND (
      NEW."resolved_attempt_id" IS DISTINCT FROM OLD."resolved_attempt_id"
      OR NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"
      OR NEW."resolution_reason" IS DISTINCT FROM OLD."resolution_reason"
      OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"))
  THEN RAISE EXCEPTION 'Legacy Stripe Customer quarantine authority is immutable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_legacy_quarantine_guard" ON "stripe_customer_legacy_quarantines";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_legacy_quarantine_guard" BEFORE UPDATE
  ON "stripe_customer_legacy_quarantines" FOR EACH ROW
  EXECUTE FUNCTION "guard_stripe_customer_legacy_quarantine"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_stripe_customer_legacy_quarantine_removal"() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'Legacy Stripe Customer quarantine authority cannot be removed';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_legacy_quarantine_delete_guard" ON "stripe_customer_legacy_quarantines";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_legacy_quarantine_delete_guard" BEFORE DELETE
  ON "stripe_customer_legacy_quarantines" FOR EACH ROW
  EXECUTE FUNCTION "prevent_stripe_customer_legacy_quarantine_removal"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_legacy_quarantine_truncate_guard" ON "stripe_customer_legacy_quarantines";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_legacy_quarantine_truncate_guard" BEFORE TRUNCATE
  ON "stripe_customer_legacy_quarantines" FOR EACH STATEMENT
  EXECUTE FUNCTION "prevent_stripe_customer_legacy_quarantine_removal"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_stripe_customer_attempt_authority"() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."request_digest" IS DISTINCT FROM OLD."request_digest"
    OR NEW."caller_intent" IS DISTINCT FROM OLD."caller_intent"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR (OLD."provider_customer_id" IS NOT NULL
      AND NEW."provider_customer_id" IS DISTINCT FROM OLD."provider_customer_id")
    OR (OLD."provider_receipt" IS NOT NULL
      AND NEW."provider_receipt" IS DISTINCT FROM OLD."provider_receipt")
    OR (OLD."provider_livemode" IS NOT NULL
      AND NEW."provider_livemode" IS DISTINCT FROM OLD."provider_livemode")
    OR (OLD."provider_started_at" IS NOT NULL
      AND NEW."provider_started_at" IS DISTINCT FROM OLD."provider_started_at")
    OR (OLD."bound_at" IS NOT NULL AND NEW."bound_at" IS DISTINCT FROM OLD."bound_at")
    OR (OLD."resolved_by" IS NOT NULL AND NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by")
    OR (OLD."resolution_reason" IS NOT NULL AND NEW."resolution_reason" IS DISTINCT FROM OLD."resolution_reason")
    OR (OLD."resolved_at" IS NOT NULL AND NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at")
    OR (NEW."status" IS NOT DISTINCT FROM OLD."status" AND (
      NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"
      OR NEW."resolution_reason" IS DISTINCT FROM OLD."resolution_reason"
      OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"))
  ) THEN RAISE EXCEPTION 'Stripe Customer attempt immutable authority changed'; END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'prepared' AND NEW."status" IN ('provider_started','quarantined'))
    OR (OLD."status" = 'provider_started' AND NEW."status" IN ('provider_ambiguous','bound','quarantined'))
    OR (OLD."status" = 'provider_ambiguous' AND NEW."status" IN ('provider_started','bound','quarantined'))
    OR (OLD."status" IN ('provider_ambiguous','quarantined') AND NEW."status" IN ('bound','abandoned'))
  ) THEN RAISE EXCEPTION 'Stripe Customer attempt invalid status transition'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_attempt_authority_guard" ON "stripe_customer_attempts";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_attempt_authority_guard"
  BEFORE UPDATE ON "stripe_customer_attempts" FOR EACH ROW
  EXECUTE FUNCTION "guard_stripe_customer_attempt_authority"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_stripe_customer_attempt_removal"() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'Stripe Customer attempt authority cannot be removed';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_attempt_delete_guard" ON "stripe_customer_attempts";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_attempt_delete_guard" BEFORE DELETE
  ON "stripe_customer_attempts" FOR EACH ROW
  EXECUTE FUNCTION "prevent_stripe_customer_attempt_removal"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_attempt_truncate_guard" ON "stripe_customer_attempts";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_attempt_truncate_guard" BEFORE TRUNCATE
  ON "stripe_customer_attempts" FOR EACH STATEMENT
  EXECUTE FUNCTION "prevent_stripe_customer_attempt_removal"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_organization_stripe_customer_publication"() RETURNS trigger AS $$
DECLARE matching_receipts integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."stripe_customer_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Organization Stripe Customer cannot be published during organization creation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."stripe_customer_id" IS NOT NULL THEN
    IF NEW."stripe_customer_id" IS DISTINCT FROM OLD."stripe_customer_id" THEN
      RAISE EXCEPTION 'Organization Stripe Customer authority is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."stripe_customer_id" IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO matching_receipts FROM "stripe_customer_attempts" a
    WHERE a."organization_id" = NEW."id" AND a."status" = 'bound'
      AND a."provider_customer_id" = NEW."stripe_customer_id"
      AND a."provider_receipt"->>'customer_id' = NEW."stripe_customer_id"
      AND a."provider_receipt"->'metadata'->>'eliza_organization_id' = NEW."id"::text
      AND a."provider_receipt"->'metadata'->>'eliza_customer_attempt_id' = a."id"::text
      AND a."provider_receipt"->'metadata'->>'eliza_customer_request_digest' = a."request_digest";
  IF matching_receipts <> 1 THEN
    RAISE EXCEPTION 'Organization Stripe Customer publication lacks one matching bound attempt receipt';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_stripe_customer_publication_guard" ON "organizations";
--> statement-breakpoint
CREATE TRIGGER "organization_stripe_customer_publication_guard"
  BEFORE UPDATE OF "stripe_customer_id" ON "organizations" FOR EACH ROW
  EXECUTE FUNCTION "guard_organization_stripe_customer_publication"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_stripe_customer_insert_guard" ON "organizations";
--> statement-breakpoint
CREATE TRIGGER "organization_stripe_customer_insert_guard"
  BEFORE INSERT ON "organizations" FOR EACH ROW
  EXECUTE FUNCTION "guard_organization_stripe_customer_publication"();

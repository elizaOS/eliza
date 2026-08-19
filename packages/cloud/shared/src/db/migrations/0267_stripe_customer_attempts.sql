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
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customer_attempts_id_org_idx"
  ON "stripe_customer_attempts" ("id", "organization_id");
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
      AND "resolution_reason" IS NOT NULL AND "resolved_at" IS NOT NULL)),
  CONSTRAINT "stripe_customer_legacy_quarantine_attempt_tenant_fk"
    FOREIGN KEY ("resolved_attempt_id", "organization_id")
    REFERENCES "stripe_customer_attempts" ("id", "organization_id") ON DELETE RESTRICT
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
CREATE OR REPLACE FUNCTION "stripe_customer_attempt_receipt_is_valid"(
  attempt_row "stripe_customer_attempts"
) RETURNS boolean AS $$
  SELECT attempt_row."status" = 'bound'
    AND jsonb_typeof(attempt_row."provider_receipt") = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(attempt_row."provider_receipt")) = 5
    AND attempt_row."provider_receipt" ?& ARRAY[
      'binding_kind','created','customer_id','livemode','metadata'
    ]
    AND jsonb_typeof(attempt_row."provider_receipt"->'customer_id') = 'string'
    AND attempt_row."provider_receipt"->>'customer_id' = attempt_row."provider_customer_id"
    AND jsonb_typeof(attempt_row."provider_receipt"->'created') = 'number'
    AND attempt_row."provider_receipt"->>'created' ~ '^[0-9]+$'
    AND jsonb_typeof(attempt_row."provider_receipt"->'livemode') = 'boolean'
    AND (attempt_row."provider_receipt"->>'livemode')::boolean = attempt_row."provider_livemode"
    AND jsonb_typeof(attempt_row."provider_receipt"->'metadata') = 'object'
    AND (
      (attempt_row."provider_receipt"->>'binding_kind' = 'attempt_created'
        AND (SELECT count(*) FROM jsonb_object_keys(attempt_row."provider_receipt"->'metadata')) = 6
        AND attempt_row."provider_receipt"->'metadata' ?& ARRAY[
          'organization_id','eliza_organization_id','eliza_customer_attempt_id',
          'eliza_customer_generation','eliza_customer_request_digest','eliza_customer_provider'
        ]
        AND attempt_row."provider_receipt"->'metadata'->>'organization_id' = attempt_row."organization_id"::text
        AND attempt_row."provider_receipt"->'metadata'->>'eliza_organization_id' = attempt_row."organization_id"::text
        AND attempt_row."provider_receipt"->'metadata'->>'eliza_customer_attempt_id' = attempt_row."id"::text
        AND attempt_row."provider_receipt"->'metadata'->>'eliza_customer_generation' = attempt_row."generation"::text
        AND attempt_row."provider_receipt"->'metadata'->>'eliza_customer_request_digest' = attempt_row."request_digest"
        AND attempt_row."provider_receipt"->'metadata'->>'eliza_customer_provider' = attempt_row."provider")
      OR
      (attempt_row."provider_receipt"->>'binding_kind' = 'legacy_verified'
        AND (SELECT count(*) FROM jsonb_object_keys(attempt_row."provider_receipt"->'metadata')) = 1
        AND attempt_row."provider_receipt"->'metadata' ? 'organization_id'
        AND attempt_row."provider_receipt"->'metadata'->>'organization_id' = attempt_row."organization_id"::text)
    );
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_stripe_customer_attempt_authority"() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'INSERT' AND (
    NEW."status" IS DISTINCT FROM 'prepared'
    OR NEW."provider_customer_id" IS NOT NULL OR NEW."provider_receipt" IS NOT NULL
    OR NEW."provider_started_at" IS NOT NULL OR NEW."bound_at" IS NOT NULL
    OR NEW."lease_token" IS NOT NULL OR NEW."lease_expires_at" IS NOT NULL
    OR NEW."ambiguous_reason" IS NOT NULL OR NEW."provider_livemode" IS NOT NULL
    OR NEW."resolved_by" IS NOT NULL OR NEW."resolution_reason" IS NOT NULL
    OR NEW."resolved_at" IS NOT NULL
    OR NEW."idempotency_key" IS DISTINCT FROM ('eliza-customer-attempt:' || NEW."id"::text)
  ) THEN RAISE EXCEPTION 'Stripe Customer attempt must be inserted as exact prepared authority'; END IF;
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
  IF NEW."status" = 'bound' AND NOT "stripe_customer_attempt_receipt_is_valid"(NEW) THEN
    RAISE EXCEPTION 'Stripe Customer attempt bound receipt is not exact provider authority';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_customer_attempt_authority_guard" ON "stripe_customer_attempts";
--> statement-breakpoint
CREATE TRIGGER "stripe_customer_attempt_authority_guard"
  BEFORE INSERT OR UPDATE ON "stripe_customer_attempts" FOR EACH ROW
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
      AND "stripe_customer_attempt_receipt_is_valid"(a);
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
--> statement-breakpoint
DO $$
DECLARE attempt_columns integer; quarantine_columns integer; required_constraints integer;
BEGIN
  SELECT count(*) INTO attempt_columns FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stripe_customer_attempts';
  SELECT count(*) INTO quarantine_columns FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stripe_customer_legacy_quarantines';
  IF attempt_columns <> 21 OR quarantine_columns <> 8 THEN
    RAISE EXCEPTION 'Stripe Customer authority table shape collision';
  END IF;

  SELECT count(*) INTO required_constraints FROM pg_constraint
    WHERE conrelid = 'stripe_customer_attempts'::regclass AND convalidated
      AND conname IN (
        'stripe_customer_attempts_generation_check','stripe_customer_attempts_digest_check',
        'stripe_customer_attempts_provider_check','stripe_customer_attempts_caller_intent_check',
        'stripe_customer_attempts_status_check','stripe_customer_attempts_bound_shape_check',
        'stripe_customer_attempts_progress_shape_check','stripe_customer_attempts_resolution_shape_check'
      );
  IF required_constraints <> 8 OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'stripe_customer_legacy_quarantines'::regclass
      AND conname = 'stripe_customer_legacy_quarantine_attempt_tenant_fk' AND convalidated
  ) THEN RAISE EXCEPTION 'Stripe Customer authority constraint collision'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'stripe_customer_attempts_org_generation_idx' AND i.indisunique
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY key(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum)
          = ARRAY['organization_id','generation']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'stripe_customer_attempts_id_org_idx' AND i.indisunique
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY key(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum)
          = ARRAY['id','organization_id']::name[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'stripe_customer_attempts_idempotency_key_idx' AND i.indisunique
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY key(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum)
          = ARRAY['idempotency_key']::name[]
  ) THEN RAISE EXCEPTION 'Stripe Customer authority index collision'; END IF;

  IF EXISTS (
    SELECT 1 FROM "stripe_customer_attempts"
      WHERE "idempotency_key" IS DISTINCT FROM ('eliza-customer-attempt:' || "id"::text)
        OR ("status" = 'bound' AND NOT "stripe_customer_attempt_receipt_is_valid"("stripe_customer_attempts"))
  ) THEN RAISE EXCEPTION 'Stripe Customer authority row postcondition failed'; END IF;
END $$;

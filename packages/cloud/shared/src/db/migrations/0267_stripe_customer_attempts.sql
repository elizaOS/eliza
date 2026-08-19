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
    ('payment_method','interactive_checkout','credit_checkout','auto_top_up')),
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
  "retirement_kind" text,
  "retirement_receipt" jsonb,
  "retired_by" text,
  "retirement_reason" text,
  "retired_at" timestamptz,
  "replacement_attempt_id" uuid,
  CONSTRAINT "stripe_customer_legacy_quarantine_resolution_shape" CHECK (
    ("resolved_attempt_id" IS NULL AND "resolved_by" IS NULL
      AND "resolution_reason" IS NULL AND "resolved_at" IS NULL)
    OR ("resolved_attempt_id" IS NOT NULL AND "resolved_by" IS NOT NULL
      AND "resolution_reason" IS NOT NULL AND "resolved_at" IS NOT NULL)),
  CONSTRAINT "stripe_customer_legacy_quarantine_attempt_tenant_fk"
    FOREIGN KEY ("resolved_attempt_id", "organization_id")
    REFERENCES "stripe_customer_attempts" ("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "stripe_customer_legacy_quarantine_replacement_tenant_fk"
    FOREIGN KEY ("replacement_attempt_id", "organization_id")
    REFERENCES "stripe_customer_attempts" ("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "stripe_customer_legacy_quarantine_retirement_shape" CHECK (
    ("retirement_kind" IS NULL AND "retirement_receipt" IS NULL AND "retired_by" IS NULL
      AND "retirement_reason" IS NULL AND "retired_at" IS NULL AND "replacement_attempt_id" IS NULL)
    OR ("retirement_kind" IN ('missing','deleted','wrong_tenant') AND "retirement_receipt" IS NOT NULL
      AND "retired_by" IS NOT NULL AND "retirement_reason" IS NOT NULL AND "retired_at" IS NOT NULL
      AND "replacement_attempt_id" IS NOT NULL AND "resolved_attempt_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stripe_customer_legacy_retirement_is_valid"(
  quarantine_row "stripe_customer_legacy_quarantines"
) RETURNS boolean AS $$
  SELECT quarantine_row."retirement_kind" IN ('missing','deleted','wrong_tenant')
    AND quarantine_row."resolved_attempt_id" IS NOT NULL
    AND quarantine_row."replacement_attempt_id" IS NOT NULL
    AND quarantine_row."retired_by" = 'system:stripe-customer-authority'
    AND jsonb_typeof(quarantine_row."retirement_receipt") = 'object'
    AND (SELECT count(*) FROM jsonb_object_keys(quarantine_row."retirement_receipt")) = 4
    AND quarantine_row."retirement_receipt" ?& ARRAY[
      'customer_id','outcome','observed_at','provider_metadata'
    ]
    AND quarantine_row."retirement_receipt"->>'customer_id' = quarantine_row."stripe_customer_id"
    AND quarantine_row."retirement_receipt"->>'outcome' = quarantine_row."retirement_kind"
    AND (quarantine_row."retirement_receipt"->>'observed_at')::timestamptz = quarantine_row."retired_at"
    AND (
      (quarantine_row."retirement_kind" IN ('missing','deleted')
        AND quarantine_row."retirement_receipt"->'provider_metadata' = 'null'::jsonb)
      OR
      (quarantine_row."retirement_kind" = 'wrong_tenant'
        AND jsonb_typeof(quarantine_row."retirement_receipt"->'provider_metadata') = 'object'
        AND (SELECT count(*) FROM jsonb_object_keys(
          quarantine_row."retirement_receipt"->'provider_metadata')) = 1
        AND quarantine_row."retirement_receipt"->'provider_metadata' ? 'organization_id'
        AND quarantine_row."retirement_receipt"->'provider_metadata'->>'organization_id'
          IS DISTINCT FROM quarantine_row."organization_id"::text)
    )
    AND EXISTS (
      SELECT 1 FROM "stripe_customer_attempts" retired
      JOIN "stripe_customer_attempts" replacement
        ON replacement."id"=quarantine_row."replacement_attempt_id"
        AND replacement."organization_id"=quarantine_row."organization_id"
        AND replacement."generation"=retired."generation"+1
      WHERE retired."id"=quarantine_row."resolved_attempt_id"
        AND retired."organization_id"=quarantine_row."organization_id"
        AND retired."status"='abandoned'
        AND retired."resolved_by"='system:stripe-customer-authority'
        AND replacement."status" IN
          ('prepared','provider_started','provider_ambiguous','bound','quarantined')
    );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "stripe_customer_legacy_quarantines" q JOIN "organizations" o
      ON o."id" = q."organization_id"
      WHERE q."resolved_attempt_id" IS NULL
        AND o."stripe_customer_id" IS DISTINCT FROM q."stripe_customer_id"
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
      OR NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
      OR NEW."retirement_kind" IS DISTINCT FROM OLD."retirement_kind"
      OR NEW."retirement_receipt" IS DISTINCT FROM OLD."retirement_receipt"
      OR NEW."retired_by" IS DISTINCT FROM OLD."retired_by"
      OR NEW."retirement_reason" IS DISTINCT FROM OLD."retirement_reason"
      OR NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
      OR NEW."replacement_attempt_id" IS DISTINCT FROM OLD."replacement_attempt_id"))
  THEN RAISE EXCEPTION 'Legacy Stripe Customer quarantine authority is immutable'; END IF;
  IF NEW."retirement_kind" IS NOT NULL
    AND NOT "stripe_customer_legacy_retirement_is_valid"(NEW)
  THEN RAISE EXCEPTION 'Legacy Stripe Customer retirement receipt is invalid'; END IF;
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
CREATE OR REPLACE FUNCTION "stripe_customer_binding_is_authoritative"(
  tenant_id uuid, customer_id text
) RETURNS boolean AS $$
  SELECT customer_id IS NOT NULL AND (
    SELECT count(*) = 1 FROM "organizations" o
    WHERE o."id" = tenant_id AND o."stripe_customer_id" = customer_id
  ) AND (
    SELECT count(*) = 1 FROM "stripe_customer_attempts" a
    WHERE a."organization_id" = tenant_id
      AND a."status" = 'bound'
      AND a."provider_customer_id" = customer_id
      AND "stripe_customer_attempt_receipt_is_valid"(a)
      AND (
        a."provider_receipt"->>'binding_kind' = 'attempt_created'
        OR (
          a."provider_receipt"->>'binding_kind' = 'legacy_verified'
          AND EXISTS (
            SELECT 1 FROM "stripe_customer_legacy_quarantines" q
            WHERE q."organization_id" = tenant_id
              AND q."stripe_customer_id" = customer_id
              AND q."resolved_attempt_id" = a."id"
              AND q."resolved_by" = 'system:stripe-customer-authority'
              AND q."resolved_at" IS NOT NULL
          )
        )
      )
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_auto_top_up_stripe_customer_authority"() RETURNS trigger AS $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "organizations" o WHERE o."id" = NEW."organization_id"
      AND o."stripe_customer_id" = NEW."stripe_customer_id_snapshot"
  ) OR NOT "stripe_customer_binding_is_authoritative"(
    NEW."organization_id", NEW."stripe_customer_id_snapshot"
  ) THEN
    RAISE EXCEPTION 'Auto top-up Stripe Customer snapshot lacks exact bound authority';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "auto_top_up_stripe_customer_authority_guard" ON "auto_top_up_attempts";
--> statement-breakpoint
CREATE TRIGGER "auto_top_up_stripe_customer_authority_guard"
  BEFORE INSERT OR UPDATE OF "provider_request_started_at", "stripe_customer_id_snapshot", "organization_id"
  ON "auto_top_up_attempts" FOR EACH ROW
  EXECUTE FUNCTION "guard_auto_top_up_stripe_customer_authority"();
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
    OR (OLD."status" = 'provider_started' AND NEW."status" IN ('provider_ambiguous','bound','quarantined','abandoned'))
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
DECLARE matching_receipts integer; matching_retirements integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."stripe_customer_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Organization Stripe Customer cannot be published during organization creation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."stripe_customer_id" IS NOT NULL THEN
    IF NEW."stripe_customer_id" IS NULL THEN
      SELECT count(*) INTO matching_retirements FROM "stripe_customer_legacy_quarantines" q
        WHERE q."organization_id" = NEW."id"
          AND q."stripe_customer_id" = OLD."stripe_customer_id"
          AND "stripe_customer_legacy_retirement_is_valid"(q);
      IF matching_retirements = 1 THEN RETURN NEW; END IF;
    END IF;
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
  expected record; actual_type text; actual_not_null boolean; actual_default text;
  actual_columns name[]; actual_unique boolean; actual_predicate text;
BEGIN
  SELECT count(*) INTO attempt_columns FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stripe_customer_attempts';
  SELECT count(*) INTO quarantine_columns FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'stripe_customer_legacy_quarantines';
  IF attempt_columns <> 21 OR quarantine_columns <> 14 THEN
    RAISE EXCEPTION 'Stripe Customer authority table shape collision';
  END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('stripe_customer_attempts','id','uuid',true,'gen_random_uuid()'),
    ('stripe_customer_attempts','organization_id','uuid',true,NULL),
    ('stripe_customer_attempts','generation','integer',true,NULL),
    ('stripe_customer_attempts','request_digest','text',true,NULL),
    ('stripe_customer_attempts','caller_intent','text',true,NULL),
    ('stripe_customer_attempts','provider','text',true,'''stripe''::text'),
    ('stripe_customer_attempts','idempotency_key','text',true,NULL),
    ('stripe_customer_attempts','status','text',true,'''prepared''::text'),
    ('stripe_customer_attempts','provider_customer_id','text',false,NULL),
    ('stripe_customer_attempts','provider_receipt','jsonb',false,NULL),
    ('stripe_customer_attempts','provider_started_at','timestamp with time zone',false,NULL),
    ('stripe_customer_attempts','bound_at','timestamp with time zone',false,NULL),
    ('stripe_customer_attempts','lease_token','uuid',false,NULL),
    ('stripe_customer_attempts','lease_expires_at','timestamp with time zone',false,NULL),
    ('stripe_customer_attempts','ambiguous_reason','text',false,NULL),
    ('stripe_customer_attempts','provider_livemode','boolean',false,NULL),
    ('stripe_customer_attempts','resolved_by','text',false,NULL),
    ('stripe_customer_attempts','resolution_reason','text',false,NULL),
    ('stripe_customer_attempts','resolved_at','timestamp with time zone',false,NULL),
    ('stripe_customer_attempts','created_at','timestamp with time zone',true,'now()'),
    ('stripe_customer_attempts','updated_at','timestamp with time zone',true,'now()'),
    ('stripe_customer_legacy_quarantines','organization_id','uuid',true,NULL),
    ('stripe_customer_legacy_quarantines','stripe_customer_id','text',true,NULL),
    ('stripe_customer_legacy_quarantines','reason','text',true,
      '''pre-authority Stripe Customer requires provider verification''::text'),
    ('stripe_customer_legacy_quarantines','created_at','timestamp with time zone',true,'now()'),
    ('stripe_customer_legacy_quarantines','resolved_attempt_id','uuid',false,NULL),
    ('stripe_customer_legacy_quarantines','resolved_by','text',false,NULL),
    ('stripe_customer_legacy_quarantines','resolution_reason','text',false,NULL),
    ('stripe_customer_legacy_quarantines','resolved_at','timestamp with time zone',false,NULL),
    ('stripe_customer_legacy_quarantines','retirement_kind','text',false,NULL),
    ('stripe_customer_legacy_quarantines','retirement_receipt','jsonb',false,NULL),
    ('stripe_customer_legacy_quarantines','retired_by','text',false,NULL),
    ('stripe_customer_legacy_quarantines','retirement_reason','text',false,NULL),
    ('stripe_customer_legacy_quarantines','retired_at','timestamp with time zone',false,NULL),
    ('stripe_customer_legacy_quarantines','replacement_attempt_id','uuid',false,NULL)
  ) AS shape(table_name,column_name,type_name,not_null,default_expr) LOOP
    SELECT format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid)
      INTO actual_type, actual_not_null, actual_default
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.oid=expected.table_name::regclass AND a.attname=expected.column_name
        AND a.attnum > 0 AND NOT a.attisdropped;
    IF actual_type IS DISTINCT FROM expected.type_name
      OR actual_not_null IS DISTINCT FROM expected.not_null
      OR actual_default IS DISTINCT FROM expected.default_expr
    THEN RAISE EXCEPTION 'Stripe Customer authority column collision: %.%',
      expected.table_name, expected.column_name; END IF;
  END LOOP;

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

  -- PostgreSQL 18 represents NOT NULL constraints in pg_constraint as
  -- contype='n'; PostgreSQL 16 and PGlite do not. Column nullability is
  -- validated above through pg_attribute, so exclude only that portable
  -- duplicate representation while still rejecting every other extra
  -- constraint type.
  IF (SELECT count(*) FROM pg_constraint
        WHERE conrelid='stripe_customer_attempts'::regclass AND contype <> 'n') <> 10
    OR (SELECT count(*) FROM pg_constraint
        WHERE conrelid='stripe_customer_legacy_quarantines'::regclass
          AND contype <> 'n') <> 7
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='stripe_customer_attempts'::regclass
        AND conname='stripe_customer_attempts_pkey' AND contype='p' AND conkey=ARRAY[1]::smallint[])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint c
      WHERE c.conrelid='stripe_customer_attempts'::regclass
        AND c.contype='f' AND c.confrelid='organizations'::regclass AND c.confdeltype='r'
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(c.conkey) WITH ORDINALITY key(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum)
          = ARRAY['organization_id']::name[])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='stripe_customer_attempts'::regclass
        AND conname='stripe_customer_attempts_generation_check' AND convalidated
        AND regexp_replace(lower(pg_get_constraintdef(oid)), '\s+', '', 'g')='check((generation>0))')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='stripe_customer_legacy_quarantines'::regclass
        AND conname='stripe_customer_legacy_quarantines_pkey' AND contype='p'
        AND conkey=ARRAY[1]::smallint[])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='stripe_customer_legacy_quarantines'::regclass
        AND conname='stripe_customer_legacy_quarantines_stripe_customer_id_key'
        AND contype='u' AND conkey=ARRAY[2]::smallint[])
    OR (SELECT count(*) FROM pg_constraint c
      WHERE c.conrelid='stripe_customer_legacy_quarantines'::regclass AND c.contype='f'
        AND c.confdeltype='r' AND c.convalidated) <> 3
  THEN RAISE EXCEPTION 'Stripe Customer authority exact constraint collision'; END IF;

  FOR expected IN SELECT * FROM (VALUES
    ('stripe_customer_attempts','stripe_customer_attempts_pkey','primarykey(id)'),
    ('stripe_customer_attempts','stripe_customer_attempts_organization_id_fkey',
      'foreignkey(organization_id)referencesorganizations(id)ondeleterestrict'),
    ('stripe_customer_attempts','stripe_customer_attempts_generation_check','check((generation>0))'),
    ('stripe_customer_attempts','stripe_customer_attempts_digest_check',
      'check((request_digest~''^[0-9a-f]{64}$''::text))'),
    ('stripe_customer_attempts','stripe_customer_attempts_provider_check',
      'check((provider=''stripe''::text))'),
    ('stripe_customer_attempts','stripe_customer_attempts_caller_intent_check',
      'check((caller_intent=any(array[''payment_method''::text,''interactive_checkout''::text,''credit_checkout''::text,''auto_top_up''::text])))'),
    ('stripe_customer_attempts','stripe_customer_attempts_status_check',
      'check((status=any(array[''prepared''::text,''provider_started''::text,''provider_ambiguous''::text,''bound''::text,''quarantined''::text,''abandoned''::text])))'),
    ('stripe_customer_attempts','stripe_customer_attempts_bound_shape_check',
      'check((((status=''bound''::text)and(provider_customer_idisnotnull)and(provider_receiptisnotnull)and(provider_livemodeisnotnull)and(bound_atisnotnull)and(lease_tokenisnull)and(lease_expires_atisnull))or((status<>''bound''::text)and(provider_customer_idisnull)and(provider_receiptisnull)and(provider_livemodeisnull)and(bound_atisnull))))'),
    ('stripe_customer_attempts','stripe_customer_attempts_progress_shape_check',
      'check((((status=''prepared''::text)and(provider_started_atisnull))or((status<>''prepared''::text)and(provider_started_atisnotnull))))'),
    ('stripe_customer_attempts','stripe_customer_attempts_resolution_shape_check',
      'check((((status=''abandoned''::text)and(resolved_byisnotnull)and(resolution_reasonisnotnull)and(resolved_atisnotnull))or(status<>''abandoned''::text)))'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantines_pkey',
      'primarykey(organization_id)'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantines_organization_id_fkey',
      'foreignkey(organization_id)referencesorganizations(id)ondeleterestrict'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantines_stripe_customer_id_key',
      'unique(stripe_customer_id)'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_attempt_tenant_fk',
      'foreignkey(resolved_attempt_id,organization_id)referencesstripe_customer_attempts(id,organization_id)ondeleterestrict'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_replacement_tenant_fk',
      'foreignkey(replacement_attempt_id,organization_id)referencesstripe_customer_attempts(id,organization_id)ondeleterestrict'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_resolution_shape',
      'check((((resolved_attempt_idisnull)and(resolved_byisnull)and(resolution_reasonisnull)and(resolved_atisnull))or((resolved_attempt_idisnotnull)and(resolved_byisnotnull)and(resolution_reasonisnotnull)and(resolved_atisnotnull))))'),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_retirement_shape',
      'check((((retirement_kindisnull)and(retirement_receiptisnull)and(retired_byisnull)and(retirement_reasonisnull)and(retired_atisnull)and(replacement_attempt_idisnull))or((retirement_kind=any(array[''missing''::text,''deleted''::text,''wrong_tenant''::text]))and(retirement_receiptisnotnull)and(retired_byisnotnull)and(retirement_reasonisnotnull)and(retired_atisnotnull)and(replacement_attempt_idisnotnull)and(resolved_attempt_idisnotnull))))')
  ) AS constraints(table_name,constraint_name,definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
      WHERE c.conrelid=expected.table_name::regclass AND c.conname=expected.constraint_name
        AND c.convalidated
        AND regexp_replace(lower(pg_get_constraintdef(c.oid)), '\s+', '', 'g')=expected.definition)
    THEN RAISE EXCEPTION 'Stripe Customer authority exact constraint collision: %',
      expected.constraint_name; END IF;
  END LOOP;

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

  FOR expected IN SELECT * FROM (VALUES
    ('stripe_customer_attempts_org_generation_idx',ARRAY['organization_id','generation']::name[],true,NULL),
    ('stripe_customer_attempts_idempotency_key_idx',ARRAY['idempotency_key']::name[],true,NULL),
    ('stripe_customer_attempts_id_org_idx',ARRAY['id','organization_id']::name[],true,NULL),
    ('stripe_customer_attempts_provider_customer_idx',ARRAY['provider_customer_id']::name[],true,
      '(provider_customer_idisnotnull)'),
    ('stripe_customer_attempts_active_org_idx',ARRAY['organization_id']::name[],true,
      '(status=any(array[''prepared''::text,''provider_started''::text,''provider_ambiguous''::text,''bound''::text]))'),
    ('stripe_customer_attempts_status_lease_idx',ARRAY['status','lease_expires_at']::name[],false,NULL)
  ) AS indexes(index_name,column_names,is_unique,predicate) LOOP
    SELECT (SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY key(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum),
        i.indisunique, regexp_replace(lower(pg_get_expr(i.indpred,i.indrelid)), '\s+', '', 'g')
      INTO actual_columns, actual_unique, actual_predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname=expected.index_name AND i.indrelid='stripe_customer_attempts'::regclass;
    IF actual_columns IS DISTINCT FROM expected.column_names
      OR actual_unique IS DISTINCT FROM expected.is_unique
      OR actual_predicate IS DISTINCT FROM expected.predicate
    THEN RAISE EXCEPTION 'Stripe Customer authority exact index collision: %', expected.index_name; END IF;
  END LOOP;

  FOR expected IN SELECT * FROM (VALUES
    ('stripe_customer_attempts','stripe_customer_attempt_authority_guard','guard_stripe_customer_attempt_authority',23,ARRAY[]::name[]),
    ('stripe_customer_attempts','stripe_customer_attempt_delete_guard','prevent_stripe_customer_attempt_removal',11,ARRAY[]::name[]),
    ('stripe_customer_attempts','stripe_customer_attempt_truncate_guard','prevent_stripe_customer_attempt_removal',34,ARRAY[]::name[]),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_guard','guard_stripe_customer_legacy_quarantine',19,ARRAY[]::name[]),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_delete_guard','prevent_stripe_customer_legacy_quarantine_removal',11,ARRAY[]::name[]),
    ('stripe_customer_legacy_quarantines','stripe_customer_legacy_quarantine_truncate_guard','prevent_stripe_customer_legacy_quarantine_removal',34,ARRAY[]::name[]),
    ('organizations','organization_stripe_customer_publication_guard','guard_organization_stripe_customer_publication',19,ARRAY['stripe_customer_id']::name[]),
    ('organizations','organization_stripe_customer_insert_guard','guard_organization_stripe_customer_publication',7,ARRAY[]::name[])
    ,('auto_top_up_attempts','auto_top_up_stripe_customer_authority_guard','guard_auto_top_up_stripe_customer_authority',23,
      ARRAY['provider_request_started_at','stripe_customer_id_snapshot','organization_id']::name[])
  ) AS triggers(table_name,trigger_name,function_name,trigger_type,column_names) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=expected.table_name::regclass AND t.tgname=expected.trigger_name
        AND p.proname=expected.function_name AND t.tgtype=expected.trigger_type
        AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0
        AND COALESCE((SELECT array_agg(a.attname ORDER BY key.ordinality)
          FROM unnest(t.tgattr) WITH ORDINALITY key(attnum,ordinality)
          JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=key.attnum),ARRAY[]::name[])
          = expected.column_names)
    THEN RAISE EXCEPTION 'Stripe Customer authority trigger collision: %', expected.trigger_name; END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM "stripe_customer_attempts"
      WHERE "idempotency_key" IS DISTINCT FROM ('eliza-customer-attempt:' || "id"::text)
        OR ("status" = 'bound' AND NOT "stripe_customer_attempt_receipt_is_valid"("stripe_customer_attempts"))
  ) THEN RAISE EXCEPTION 'Stripe Customer authority row postcondition failed'; END IF;
END $$;

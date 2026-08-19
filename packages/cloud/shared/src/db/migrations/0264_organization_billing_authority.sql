-- Makes organizations the canonical Stripe billing row while the split table remains a guarded shadow.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "organization_billing" WHERE
    ("auto_top_up_amount" IS NOT NULL AND "auto_top_up_amount" <> round("auto_top_up_amount", 2))
    OR ("auto_top_up_threshold" IS NOT NULL AND "auto_top_up_threshold" <> round("auto_top_up_threshold", 2)))
  THEN RAISE EXCEPTION 'legacy auto-top-up values contain unsupported sub-cent precision'
    USING ERRCODE = '22003', CONSTRAINT = 'organization_billing_cent_precision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "organizations" o JOIN "organization_billing" b
      ON b."organization_id" = o."id"
    WHERE (o."stripe_customer_id" IS NOT NULL AND b."stripe_customer_id" IS NOT NULL
        AND o."stripe_customer_id" IS DISTINCT FROM b."stripe_customer_id")
      OR (o."billing_email" IS NOT NULL AND b."billing_email" IS NOT NULL
        AND o."billing_email" IS DISTINCT FROM b."billing_email")
      OR (o."stripe_payment_method_id" IS NOT NULL AND b."stripe_payment_method_id" IS NOT NULL
        AND o."stripe_payment_method_id" IS DISTINCT FROM b."stripe_payment_method_id")
      OR (o."stripe_default_payment_method" IS NOT NULL
        AND b."stripe_default_payment_method" IS NOT NULL
        AND o."stripe_default_payment_method" IS DISTINCT FROM b."stripe_default_payment_method")
      OR o."auto_top_up_enabled" IS DISTINCT FROM b."auto_top_up_enabled"
      OR (o."auto_top_up_amount" IS NOT NULL AND b."auto_top_up_amount" IS NOT NULL
        AND o."auto_top_up_amount" IS DISTINCT FROM b."auto_top_up_amount")
      OR (o."auto_top_up_threshold" IS NOT NULL AND b."auto_top_up_threshold" IS NOT NULL
        AND o."auto_top_up_threshold" IS DISTINCT FROM b."auto_top_up_threshold")
  ) THEN RAISE EXCEPTION 'organization billing authority migration found divergent duplicate rows'
    USING ERRCODE = '23514', CONSTRAINT = 'organization_billing_authority_divergence',
      HINT = 'compare organizations and organization_billing by organization_id before retrying';
  END IF;

  IF EXISTS (
    SELECT COALESCE(o."stripe_customer_id", b."stripe_customer_id")
    FROM "organizations" o LEFT JOIN "organization_billing" b ON b."organization_id" = o."id"
    WHERE COALESCE(o."stripe_customer_id", b."stripe_customer_id") IS NOT NULL
    GROUP BY COALESCE(o."stripe_customer_id", b."stripe_customer_id") HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'Stripe customer identity is linked to multiple organizations'
    USING ERRCODE = '23505', CONSTRAINT = 'organizations_stripe_customer_authority_unique',
      HINT = 'group the coalesced stripe_customer_id by organization and resolve every duplicate';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "organizations" o SET
  "stripe_customer_id" = COALESCE(o."stripe_customer_id", b."stripe_customer_id"),
  "billing_email" = COALESCE(o."billing_email", b."billing_email"),
  "stripe_payment_method_id" = COALESCE(o."stripe_payment_method_id", b."stripe_payment_method_id"),
  "stripe_default_payment_method" = COALESCE(o."stripe_default_payment_method", b."stripe_default_payment_method"),
  "auto_top_up_amount" = COALESCE(o."auto_top_up_amount", b."auto_top_up_amount"),
  "auto_top_up_threshold" = COALESCE(o."auto_top_up_threshold", b."auto_top_up_threshold")
FROM "organization_billing" b
WHERE b."organization_id" = o."id" AND (
  (o."stripe_customer_id" IS NULL AND b."stripe_customer_id" IS NOT NULL)
  OR (o."billing_email" IS NULL AND b."billing_email" IS NOT NULL)
  OR (o."stripe_payment_method_id" IS NULL AND b."stripe_payment_method_id" IS NOT NULL)
  OR (o."stripe_default_payment_method" IS NULL
    AND b."stripe_default_payment_method" IS NOT NULL)
  OR (o."auto_top_up_amount" IS NULL AND b."auto_top_up_amount" IS NOT NULL)
  OR (o."auto_top_up_threshold" IS NULL AND b."auto_top_up_threshold" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_stripe_customer_authority_unique"
  ON "organizations" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_billing_stripe_customer_authority_unique"
  ON "organization_billing" ("stripe_customer_id") WHERE "stripe_customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sync_organization_billing_shadow"() RETURNS trigger AS $$ BEGIN
  INSERT INTO "organization_billing" (
    "organization_id", "stripe_customer_id", "billing_email", "stripe_payment_method_id",
    "stripe_default_payment_method", "auto_top_up_enabled", "auto_top_up_amount",
    "auto_top_up_threshold", "updated_at"
  ) VALUES (
    NEW."id", NEW."stripe_customer_id", NEW."billing_email", NEW."stripe_payment_method_id",
    NEW."stripe_default_payment_method", COALESCE(NEW."auto_top_up_enabled", false),
    NEW."auto_top_up_amount", NEW."auto_top_up_threshold", clock_timestamp()
  ) ON CONFLICT ("organization_id") DO UPDATE SET
    "stripe_customer_id" = EXCLUDED."stripe_customer_id", "billing_email" = EXCLUDED."billing_email",
    "stripe_payment_method_id" = EXCLUDED."stripe_payment_method_id",
    "stripe_default_payment_method" = EXCLUDED."stripe_default_payment_method",
    "auto_top_up_enabled" = EXCLUDED."auto_top_up_enabled",
    "auto_top_up_amount" = EXCLUDED."auto_top_up_amount",
    "auto_top_up_threshold" = EXCLUDED."auto_top_up_threshold", "updated_at" = clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organizations_billing_shadow_sync" ON "organizations";
CREATE TRIGGER "organizations_billing_shadow_sync" AFTER INSERT OR UPDATE OF
  "stripe_customer_id", "billing_email", "stripe_payment_method_id",
  "stripe_default_payment_method", "auto_top_up_enabled", "auto_top_up_amount", "auto_top_up_threshold"
ON "organizations" FOR EACH ROW EXECUTE FUNCTION "sync_organization_billing_shadow"();
--> statement-breakpoint
INSERT INTO "organization_billing" (
  "organization_id", "stripe_customer_id", "billing_email", "stripe_payment_method_id",
  "stripe_default_payment_method", "auto_top_up_enabled", "auto_top_up_amount",
  "auto_top_up_threshold", "updated_at"
)
SELECT
  o."id", o."stripe_customer_id", o."billing_email", o."stripe_payment_method_id",
  o."stripe_default_payment_method", COALESCE(o."auto_top_up_enabled", false),
  o."auto_top_up_amount", o."auto_top_up_threshold", clock_timestamp()
FROM "organizations" o
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_billing" b WHERE b."organization_id" = o."id"
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_organization_billing_shadow"() RETURNS trigger AS $$ BEGIN
  -- Canonical synchronization and organization-owned cascades enter this trigger
  -- at depth two. Direct shadow mutations enter at depth one and never acquire
  -- the organization row, preserving organizations -> shadow lock order.
  IF pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'organization_billing is a read-only shadow of organizations'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_billing_shadow_mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_billing_shadow_insert_guard" ON "organization_billing";
CREATE TRIGGER "organization_billing_shadow_insert_guard" BEFORE INSERT
ON "organization_billing" FOR EACH ROW EXECUTE FUNCTION "guard_organization_billing_shadow"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_billing_shadow_update_guard" ON "organization_billing";
CREATE TRIGGER "organization_billing_shadow_update_guard" BEFORE UPDATE OF
  "stripe_customer_id", "billing_email", "stripe_payment_method_id",
  "stripe_default_payment_method", "auto_top_up_enabled", "auto_top_up_amount",
  "auto_top_up_threshold", "updated_at"
ON "organization_billing" FOR EACH ROW EXECUTE FUNCTION "guard_organization_billing_shadow"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "touch_organization_billing_shadow_metadata"() RETURNS trigger AS $$ BEGIN
  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_billing_shadow_metadata_touch" ON "organization_billing";
CREATE TRIGGER "organization_billing_shadow_metadata_touch" BEFORE UPDATE OF
  "tax_id_type", "tax_id_value", "billing_address"
ON "organization_billing" FOR EACH ROW
EXECUTE FUNCTION "touch_organization_billing_shadow_metadata"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_billing_shadow_delete_guard" ON "organization_billing";
CREATE TRIGGER "organization_billing_shadow_delete_guard" BEFORE DELETE
ON "organization_billing" FOR EACH ROW EXECUTE FUNCTION "guard_organization_billing_shadow"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_organization_billing_shadow_truncate"() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'organization_billing is a read-only shadow of organizations and cannot be truncated'
    USING ERRCODE = '23514', CONSTRAINT = 'organization_billing_shadow_mismatch';
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "organization_billing_shadow_truncate_guard" ON "organization_billing";
CREATE TRIGGER "organization_billing_shadow_truncate_guard" BEFORE TRUNCATE
ON "organization_billing" FOR EACH STATEMENT
EXECUTE FUNCTION "guard_organization_billing_shadow_truncate"();

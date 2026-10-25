CREATE TABLE IF NOT EXISTS "stripe_checkout_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "initiated_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "client_request_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "purchase_type" text NOT NULL,
  "credit_pack_id" uuid REFERENCES "credit_packs"("id") ON DELETE RESTRICT,
  "credits_to_grant" numeric(16,6) NOT NULL,
  "charge_amount_cents" bigint NOT NULL,
  "currency" text NOT NULL,
  "stripe_customer_id" text,
  "stripe_checkout_session_id" text,
  "stripe_payment_intent_id" text,
  "credit_transaction_id" uuid REFERENCES "credit_transactions"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'quoted',
  "provider_error_code" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "settled_at" timestamptz,
  CONSTRAINT "stripe_checkout_orders_status_check"
    CHECK ("status" IN ('quoted','provider_started','delivered','provider_ambiguous','settled','failed')),
  CONSTRAINT "stripe_checkout_orders_purchase_type_check"
    CHECK ("purchase_type" IN ('custom_amount','credit_pack')),
  CONSTRAINT "stripe_checkout_orders_amount_check"
    CHECK ("credits_to_grant" > 0 AND "credits_to_grant" <= 10000 AND "charge_amount_cents" > 0),
  CONSTRAINT "stripe_checkout_orders_currency_check"
    CHECK ("currency" = lower("currency") AND "currency" ~ '^[a-z]{3}$'),
  CONSTRAINT "stripe_checkout_orders_request_key_check"
    CHECK ("client_request_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT "stripe_checkout_orders_request_digest_check"
    CHECK ("request_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "stripe_checkout_orders_pack_shape_check"
    CHECK (("purchase_type" = 'credit_pack' AND "credit_pack_id" IS NOT NULL)
      OR ("purchase_type" = 'custom_amount' AND "credit_pack_id" IS NULL)),
  CONSTRAINT "stripe_checkout_orders_settlement_shape_check"
    CHECK (("status" = 'settled'
      AND "stripe_customer_id" IS NOT NULL
      AND "stripe_checkout_session_id" IS NOT NULL
      AND "stripe_payment_intent_id" IS NOT NULL
      AND "credit_transaction_id" IS NOT NULL
      AND "settled_at" IS NOT NULL)
      OR ("status" <> 'settled' AND "credit_transaction_id" IS NULL AND "settled_at" IS NULL)),
  CONSTRAINT "stripe_checkout_orders_phase_shape_check"
    CHECK (("status" IN ('quoted','provider_started','provider_ambiguous')
        AND "stripe_checkout_session_id" IS NULL AND "stripe_payment_intent_id" IS NULL
        AND ("status" = 'quoted' OR "stripe_customer_id" IS NOT NULL))
      OR ("status" = 'delivered'
        AND "stripe_customer_id" IS NOT NULL
        AND "stripe_checkout_session_id" IS NOT NULL AND "stripe_payment_intent_id" IS NULL)
      OR "status" IN ('settled','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_checkout_legacy_quarantine" (
  "checkout_session_id" text PRIMARY KEY,
  "stripe_payment_intent_id" text NOT NULL UNIQUE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "initiated_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "stripe_customer_id" text,
  "credit_pack_id" uuid,
  "claimed_credits" text,
  "charge_amount_cents" bigint,
  "currency" text,
  "reason" text NOT NULL,
  "provider_receipt" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_stripe_checkout_legacy_quarantine_tenant"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_organization_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."checkout_session_id" IS DISTINCT FROM OLD."checkout_session_id"
    OR NEW."stripe_payment_intent_id" IS DISTINCT FROM OLD."stripe_payment_intent_id"
    OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."initiated_by_user_id" IS DISTINCT FROM OLD."initiated_by_user_id"
    OR NEW."stripe_customer_id" IS DISTINCT FROM OLD."stripe_customer_id"
    OR NEW."credit_pack_id" IS DISTINCT FROM OLD."credit_pack_id"
    OR NEW."claimed_credits" IS DISTINCT FROM OLD."claimed_credits"
    OR NEW."charge_amount_cents" IS DISTINCT FROM OLD."charge_amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."provider_receipt" IS DISTINCT FROM OLD."provider_receipt"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'legacy Stripe quarantine authority is immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "organization_id"
    INTO linked_organization_id
    FROM "users"
    WHERE "id" = NEW."initiated_by_user_id"
    FOR SHARE;
  IF NOT FOUND OR linked_organization_id IS DISTINCT FROM NEW."organization_id" THEN
    RAISE EXCEPTION 'legacy Stripe quarantine user organization mismatch';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_checkout_legacy_quarantine_tenant_trigger"
  ON "stripe_checkout_legacy_quarantine";
--> statement-breakpoint
CREATE TRIGGER "stripe_checkout_legacy_quarantine_tenant_trigger"
  BEFORE INSERT OR UPDATE ON "stripe_checkout_legacy_quarantine"
  FOR EACH ROW EXECUTE FUNCTION "enforce_stripe_checkout_legacy_quarantine_tenant"();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_checkout_legacy_quarantine_org_created_idx"
  ON "stripe_checkout_legacy_quarantine" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_checkout_orders_org_created_idx"
  ON "stripe_checkout_orders" ("organization_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_checkout_orders_org_request_idx"
  ON "stripe_checkout_orders" ("organization_id", "client_request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_checkout_orders_status_updated_idx"
  ON "stripe_checkout_orders" ("status", "updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_checkout_orders_session_idx"
  ON "stripe_checkout_orders" ("stripe_checkout_session_id")
  WHERE "stripe_checkout_session_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_checkout_orders_payment_intent_idx"
  ON "stripe_checkout_orders" ("stripe_payment_intent_id")
  WHERE "stripe_payment_intent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_checkout_orders_credit_transaction_idx"
  ON "stripe_checkout_orders" ("credit_transaction_id")
  WHERE "credit_transaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stripe_checkout_order_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  credit_row "credit_transactions"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."initiated_by_user_id" IS DISTINCT FROM OLD."initiated_by_user_id"
    OR NEW."client_request_key" IS DISTINCT FROM OLD."client_request_key"
    OR NEW."request_digest" IS DISTINCT FROM OLD."request_digest"
    OR NEW."purchase_type" IS DISTINCT FROM OLD."purchase_type"
    OR NEW."credit_pack_id" IS DISTINCT FROM OLD."credit_pack_id"
    OR NEW."credits_to_grant" IS DISTINCT FROM OLD."credits_to_grant"
    OR NEW."charge_amount_cents" IS DISTINCT FROM OLD."charge_amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR (OLD."stripe_customer_id" IS NOT NULL
      AND NEW."stripe_customer_id" IS DISTINCT FROM OLD."stripe_customer_id")
    OR (OLD."stripe_checkout_session_id" IS NOT NULL
      AND NEW."stripe_checkout_session_id" IS DISTINCT FROM OLD."stripe_checkout_session_id")
    OR (OLD."stripe_payment_intent_id" IS NOT NULL
      AND NEW."stripe_payment_intent_id" IS DISTINCT FROM OLD."stripe_payment_intent_id")
    OR (OLD."credit_transaction_id" IS NOT NULL
      AND NEW."credit_transaction_id" IS DISTINCT FROM OLD."credit_transaction_id")
  ) THEN
    RAISE EXCEPTION 'stripe checkout immutable authority changed';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'quoted' AND NEW."status" IN ('provider_started','failed'))
    OR (OLD."status" = 'provider_started' AND NEW."status" IN ('delivered','provider_ambiguous','failed'))
    OR (OLD."status" = 'provider_ambiguous' AND NEW."status" IN ('provider_started','delivered','failed'))
    OR (OLD."status" = 'delivered' AND NEW."status" IN ('settled','failed'))
  ) THEN
    RAISE EXCEPTION 'stripe checkout invalid status transition';
  END IF;

  IF NEW."credit_transaction_id" IS NOT NULL THEN
    SELECT * INTO credit_row
      FROM "credit_transactions" WHERE "id" = NEW."credit_transaction_id";
    IF NOT FOUND
      OR credit_row."organization_id" IS DISTINCT FROM NEW."organization_id"
      OR credit_row."type" IS DISTINCT FROM 'credit'
      OR credit_row."amount" IS DISTINCT FROM NEW."credits_to_grant"
      OR credit_row."stripe_payment_intent_id" IS DISTINCT FROM NEW."stripe_payment_intent_id"
      OR credit_row."metadata"->>'checkout_order_id' IS DISTINCT FROM NEW."id"::text
    THEN
      RAISE EXCEPTION 'stripe checkout credit transaction binding mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "stripe_checkout_order_binding_guard" ON "stripe_checkout_orders";
--> statement-breakpoint
CREATE TRIGGER "stripe_checkout_order_binding_guard"
  BEFORE INSERT OR UPDATE ON "stripe_checkout_orders"
  FOR EACH ROW EXECUTE FUNCTION stripe_checkout_order_binding_guard();

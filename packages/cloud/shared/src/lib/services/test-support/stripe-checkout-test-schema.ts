/** Shared PGlite fixture for the Checkout authority and route recovery tests. */
import { readFile } from "node:fs/promises";

export async function installStripeCheckoutTestSchema(
  execute: (query: string) => Promise<unknown>,
): Promise<void> {
  await execute(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) NOT NULL DEFAULT 0,
      stripe_customer_id text, settings jsonb NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id)
    );
    CREATE TABLE credit_packs (
      id uuid PRIMARY KEY, name text NOT NULL, description text,
      credits numeric(10,2) NOT NULL, price_cents integer NOT NULL,
      stripe_price_id text NOT NULL, stripe_product_id text NOT NULL,
      is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid,
      amount numeric(12,6) NOT NULL, type text NOT NULL, description text,
      metadata jsonb NOT NULL DEFAULT '{}', stripe_payment_intent_id text,
      created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
    );
    CREATE UNIQUE INDEX credit_transactions_stripe_payment_intent_idx
      ON credit_transactions(stripe_payment_intent_id);
    CREATE TABLE stripe_checkout_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      initiated_by_user_id uuid NOT NULL REFERENCES users(id),
      client_request_key text NOT NULL, request_digest text NOT NULL,
      purchase_type text NOT NULL, credit_pack_id uuid REFERENCES credit_packs(id),
      credits_to_grant numeric(16,6) NOT NULL, charge_amount_cents bigint NOT NULL,
      currency text NOT NULL, stripe_customer_id text,
      stripe_checkout_session_id text, stripe_payment_intent_id text,
      credit_transaction_id uuid REFERENCES credit_transactions(id),
      status text NOT NULL DEFAULT 'quoted', provider_error_code text,
      metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
    );
    CREATE UNIQUE INDEX stripe_checkout_orders_session_idx
      ON stripe_checkout_orders(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
    CREATE UNIQUE INDEX stripe_checkout_orders_payment_intent_idx
      ON stripe_checkout_orders(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
    CREATE UNIQUE INDEX stripe_checkout_orders_credit_transaction_idx
      ON stripe_checkout_orders(credit_transaction_id) WHERE credit_transaction_id IS NOT NULL;
    CREATE UNIQUE INDEX stripe_checkout_orders_org_request_idx
      ON stripe_checkout_orders(organization_id, client_request_key);
    CREATE TABLE stripe_checkout_legacy_quarantine (
      checkout_session_id text PRIMARY KEY,
      stripe_payment_intent_id text NOT NULL UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      initiated_by_user_id uuid NOT NULL REFERENCES users(id),
      stripe_customer_id text, credit_pack_id uuid, claimed_credits text,
      charge_amount_cents bigint, currency text, reason text NOT NULL,
      provider_receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
    );
    CREATE FUNCTION enforce_test_quarantine_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE linked_organization_id uuid;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
        OR NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
        OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
        OR NEW.credit_pack_id IS DISTINCT FROM OLD.credit_pack_id
        OR NEW.claimed_credits IS DISTINCT FROM OLD.claimed_credits
        OR NEW.charge_amount_cents IS DISTINCT FROM OLD.charge_amount_cents
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.provider_receipt IS DISTINCT FROM OLD.provider_receipt
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'legacy Stripe quarantine authority is immutable';
        END IF;
        RETURN NEW;
      END IF;
      SELECT organization_id INTO linked_organization_id
        FROM users WHERE id = NEW.initiated_by_user_id FOR SHARE;
      IF NOT FOUND OR linked_organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'legacy Stripe quarantine user organization mismatch';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_quarantine_tenant_trigger
      BEFORE INSERT OR UPDATE ON stripe_checkout_legacy_quarantine
      FOR EACH ROW EXECUTE FUNCTION enforce_test_quarantine_tenant();
  `);
  await execute(
    await readFile(
      new URL(
        "../../../db/migrations/0559_stripe_checkout_provider_started_at.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

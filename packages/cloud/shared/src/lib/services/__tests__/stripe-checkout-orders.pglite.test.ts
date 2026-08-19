/**
 * Proves Stripe Checkout quote binding and atomic fulfillment against real PGlite transactions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { sqlRows } from "../../../db/execute-helpers";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const USER_A = "20000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const PACK_A = "40000000-0000-4000-8000-000000000001";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let service: typeof import("../stripe-checkout-orders").stripeCheckoutOrdersService;
let creditsService: typeof import("../credits").creditsService;

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../../db/client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ stripeCheckoutOrdersService: service } = await import("../stripe-checkout-orders"));
  ({ creditsService } = await import("../credits"));

  const pglite = client.getPgliteClientForTests();
  if (!pglite) throw new Error("PGlite test client was not initialized");
  await pglite.exec(`
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
});

afterAll(async () => closeDb());

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM stripe_checkout_legacy_quarantine`);
  await dbWrite.execute(sql`DELETE FROM stripe_checkout_orders`);
  await dbWrite.execute(sql`DELETE FROM credit_transactions`);
  await dbWrite.execute(sql`DELETE FROM credit_packs`);
  await dbWrite.execute(sql`DELETE FROM users`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(
    sql.raw(`INSERT INTO organizations (id, name, slug, stripe_customer_id) VALUES
    ('${ORG_A}', 'A', 'a', 'cus_a'), ('${ORG_B}', 'B', 'b', 'cus_b')`),
  );
  await dbWrite.execute(
    sql.raw(`INSERT INTO users (id, organization_id) VALUES
      ('${USER_A}', '${ORG_A}'), ('${USER_B}', '${ORG_B}')`),
  );
  await dbWrite.execute(
    sql.raw(`INSERT INTO credit_packs
    (id, name, credits, price_cents, stripe_price_id, stripe_product_id)
    VALUES ('${PACK_A}', 'Pack A', 25, 500, 'price_a', 'prod_a')`),
  );
});

async function deliveredOrder(input?: {
  orgId?: string;
  userId?: string;
  credits?: string;
  cents?: number;
  customer?: string;
  session?: string;
}) {
  const order = await service.create({
    organizationId: input?.orgId ?? ORG_A,
    initiatedByUserId: input?.userId ?? USER_A,
    clientRequestKey: `request-${input?.session ?? "cs_a"}`,
    requestDigest: "a".repeat(64),
    purchaseType: "custom_amount",
    creditsToGrant: input?.credits ?? "17.000000",
    chargeAmountCents: input?.cents ?? 500,
    currency: "usd",
    stripeCustomerId: input?.customer ?? "cus_a",
  });
  await service.markProviderStarted(order.id);
  await service.bindSession(order.id, input?.session ?? "cs_a");
  return order;
}

function receipt(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    checkoutOrderId: orderId,
    clientReferenceId: orderId,
    metadataOrderId: orderId,
    checkoutSessionId: "cs_a",
    paymentIntentId: "pi_a",
    paymentStatus: "paid",
    amountTotal: 500,
    currency: "usd",
    customerId: "cus_a",
    ...overrides,
  } as Parameters<typeof service.settle>[0];
}

async function rows() {
  return {
    balances: await sqlRows<{ id: string; credit_balance: string }>(
      dbWrite,
      sql`SELECT id, credit_balance FROM organizations ORDER BY id`,
    ),
    credits: await sqlRows<{
      organization_id: string;
      amount: string;
      stripe_payment_intent_id: string;
    }>(
      dbWrite,
      sql`SELECT organization_id, amount, stripe_payment_intent_id FROM credit_transactions`,
    ),
    orders: await sqlRows<{
      status: string;
      stripe_payment_intent_id: string | null;
      credit_transaction_id: string | null;
    }>(
      dbWrite,
      sql`SELECT status, stripe_payment_intent_id, credit_transaction_id FROM stripe_checkout_orders`,
    ),
  };
}

describe("Stripe Checkout order authority", () => {
  test("reuses one tenant request and rejects a changed digest or user", async () => {
    const input = {
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      clientRequestKey: "request-idempotency-a",
      requestDigest: "a".repeat(64),
      purchaseType: "custom_amount" as const,
      creditsToGrant: "5.000000",
      chargeAmountCents: 500,
      currency: "usd",
      stripeCustomerId: "cus_a",
    };
    const first = await service.create(input);
    await service.markProviderStarted(first.id);
    await service.markProviderAmbiguous(first.id, "network_timeout");
    const retry = await service.create(input);
    expect(retry.id).toBe(first.id);
    expect(retry.status).toBe("provider_ambiguous");
    await service.markProviderStarted(retry.id);
    await expect(service.create({ ...input, requestDigest: "b".repeat(64) })).rejects.toThrow(
      "different request",
    );
    await expect(service.create({ ...input, initiatedByUserId: USER_B })).rejects.toThrow(
      "different request",
    );
  });

  test("grants server-owned pack credits independently from exact charge cents", async () => {
    const order = await deliveredOrder();
    const result = await service.settle(receipt(order.id), {
      callerOrganizationId: ORG_A,
      callerUserId: USER_A,
    });
    expect(result).toMatchObject({ alreadyApplied: false, newBalance: 17 });
    const state = await rows();
    expect(state.balances[0]?.credit_balance).toBe("17.000000");
    expect(state.credits).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        amount: "17.000000",
        stripe_payment_intent_id: "pi_a",
      }),
    ]);
    expect(state.orders[0]).toMatchObject({
      status: "settled",
      stripe_payment_intent_id: "pi_a",
      credit_transaction_id: expect.any(String),
    });
    expect(await creditsService.getTransactionByStripePaymentIntent("pi_a")).toMatchObject({
      organization_id: ORG_A,
      amount: "17.000000",
    });
  });

  test("concurrent webhook and landing verification converge on one grant", async () => {
    const order = await deliveredOrder();
    const results = await Promise.all([
      service.settle(receipt(order.id)),
      service.settle(receipt(order.id)),
      service.settle(receipt(order.id)),
    ]);
    expect(results.filter((result) => !result.alreadyApplied)).toHaveLength(1);
    const state = await rows();
    expect(state.credits).toHaveLength(1);
    expect(state.balances[0]?.credit_balance).toBe("17.000000");
  });

  test("trusted webhook or verify receipts recover Session-create ACK loss exactly once", async () => {
    const order = await service.create({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      clientRequestKey: "request-ack-loss-a",
      requestDigest: "c".repeat(64),
      purchaseType: "custom_amount",
      creditsToGrant: "5.000000",
      chargeAmountCents: 500,
      currency: "usd",
      stripeCustomerId: null,
    });
    const pinned = await service.bindCustomer(order.id, "cus_a");
    expect(pinned.stripe_customer_id).toBe("cus_a");
    await service.markProviderStarted(order.id);

    const results = await Promise.all([
      service.settle(receipt(order.id)),
      service.settle(receipt(order.id)),
    ]);
    expect(results.filter((result) => !result.alreadyApplied)).toHaveLength(1);
    expect(results.every((result) => result.order.stripe_checkout_session_id === "cs_a")).toBe(
      true,
    );
    expect((await rows()).credits).toHaveLength(1);
  });

  test("webhook-first and verify-first ACK-loss receipts both settle and replay", async () => {
    for (const [channel, sessionId, paymentIntentId] of [
      ["webhook-first", "cs_webhook_first", "pi_webhook_first"],
      ["verify-first", "cs_verify_first", "pi_verify_first"],
    ] as const) {
      const order = await service.create({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        clientRequestKey: `request-${channel}`,
        requestDigest: channel === "webhook-first" ? "f".repeat(64) : "1".repeat(64),
        purchaseType: "custom_amount",
        creditsToGrant: "5.000000",
        chargeAmountCents: 500,
        currency: "usd",
        stripeCustomerId: "cus_a",
      });
      await service.markProviderStarted(order.id);
      const trustedReceipt = receipt(order.id, {
        checkoutSessionId: sessionId,
        paymentIntentId,
      });
      const first = await service.settle(trustedReceipt);
      const replay = await service.settle(trustedReceipt);
      expect(first.alreadyApplied).toBe(false);
      expect(replay.alreadyApplied).toBe(true);
    }
    expect((await rows()).credits).toHaveLength(2);
  });

  test("ACK-loss recovery rejects wrong client reference, metadata order, and Session races", async () => {
    const makeStarted = async (key: string) => {
      const order = await service.create({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        clientRequestKey: key,
        requestDigest: "d".repeat(64),
        purchaseType: "custom_amount",
        creditsToGrant: "5.000000",
        chargeAmountCents: 500,
        currency: "usd",
        stripeCustomerId: "cus_a",
      });
      await service.markProviderStarted(order.id);
      return order;
    };
    const wrongReference = await makeStarted("request-wrong-ref-a");
    await expect(
      service.settle(receipt(wrongReference.id, { clientReferenceId: "wrong" })),
    ).rejects.toThrow("order receipt");
    const wrongMetadata = await makeStarted("request-wrong-meta-a");
    await expect(
      service.settle(receipt(wrongMetadata.id, { metadataOrderId: "wrong" })),
    ).rejects.toThrow("order receipt");
    const raced = await makeStarted("request-session-race-a");
    await service.settle(receipt(raced.id));
    await expect(
      service.settle(receipt(raced.id, { checkoutSessionId: "cs_other" })),
    ).rejects.toThrow("session");
  });

  test("customer pinning accepts only the customer already published by authority", async () => {
    const order = await service.create({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      clientRequestKey: "request-customer-race-a",
      requestDigest: "e".repeat(64),
      purchaseType: "custom_amount",
      creditsToGrant: "5.000000",
      chargeAmountCents: 500,
      currency: "usd",
      stripeCustomerId: null,
    });
    await expect(service.bindCustomer(order.id, "cus_candidate_a")).rejects.toThrow(
      "must already be published",
    );
    const pinned = await service.bindCustomer(order.id, "cus_a");
    expect(pinned.stripe_customer_id).toBe("cus_a");
    expect((await service.bindCustomer(order.id, "cus_changed_later")).stripe_customer_id).toBe(
      "cus_a",
    );
  });

  test("fails closed on tenant, user, amount, currency, customer, session, and payment status", async () => {
    const mutations: Array<
      [string, Parameters<typeof service.settle>[0], Parameters<typeof service.settle>[1]]
    > = [];
    const order = await deliveredOrder();
    mutations.push(
      ["organization", receipt(order.id), { callerOrganizationId: ORG_B }],
      ["user", receipt(order.id), { callerUserId: USER_B }],
      ["amount", receipt(order.id, { amountTotal: 501 }), {}],
      ["currency", receipt(order.id, { currency: "eur" }), {}],
      ["customer", receipt(order.id, { customerId: "cus_other" }), {}],
      ["session", receipt(order.id, { checkoutSessionId: "cs_other" }), {}],
      ["payment status", receipt(order.id, { paymentStatus: "unpaid" }), {}],
    );
    for (const [field, invalidReceipt, options] of mutations) {
      await expect(service.settle(invalidReceipt, options)).rejects.toThrow(field);
    }
    const state = await rows();
    expect(state.credits).toHaveLength(0);
    expect(state.balances[0]?.credit_balance).toBe("0.000000");
    expect(state.orders[0]?.status).toBe("delivered");
  });

  test("conflicting payment-intent replay cannot reuse a settled order", async () => {
    const order = await deliveredOrder();
    await service.settle(receipt(order.id));
    await expect(
      service.settle(receipt(order.id, { paymentIntentId: "pi_conflict" })),
    ).rejects.toThrow("payment intent");
    const state = await rows();
    expect(state.credits).toHaveLength(1);
    expect(state.credits[0]?.stripe_payment_intent_id).toBe("pi_a");
  });

  test("post-ledger failure rolls the grant back and a retry settles cleanly", async () => {
    const order = await deliveredOrder();
    const realAddCredits = creditsService.addCredits.bind(creditsService);
    let inject = true;
    creditsService.addCredits = async (params) => {
      const result = await realAddCredits(params);
      if (inject) {
        inject = false;
        throw new Error("injected after ledger write");
      }
      return result;
    };
    try {
      await expect(service.settle(receipt(order.id))).rejects.toThrow(
        "injected after ledger write",
      );
      let state = await rows();
      expect(state.credits).toHaveLength(0);
      expect(state.balances[0]?.credit_balance).toBe("0.000000");
      expect(state.orders[0]?.status).toBe("delivered");

      await expect(service.settle(receipt(order.id))).resolves.toMatchObject({
        alreadyApplied: false,
      });
      state = await rows();
      expect(state.credits).toHaveLength(1);
      expect(state.balances[0]?.credit_balance).toBe("17.000000");
    } finally {
      creditsService.addCredits = realAddCredits;
    }
  });

  test("legacy custom cutover derives from paid cents and packs are durably quarantined", async () => {
    const custom = await service.settleLegacy({
      checkoutSessionId: "cs_legacy_custom",
      paymentIntentId: "pi_legacy_custom",
      paymentStatus: "paid",
      amountTotal: 500,
      currency: "usd",
      customerId: "cus_a",
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      purchaseType: "custom_amount",
      creditPackId: null,
      claimedCredits: "5.00",
    });
    expect(custom).toMatchObject({ creditsToGrant: "5.000000", newBalance: 5 });

    const quarantinePack = async (session: string, paymentIntent: string) =>
      service.settleLegacy({
        checkoutSessionId: session,
        paymentIntentId: paymentIntent,
        paymentStatus: "paid",
        amountTotal: 500,
        currency: "usd",
        customerId: "cus_a",
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        purchaseType: "credit_pack",
        creditPackId: PACK_A,
        claimedCredits: "25.00",
      });
    await expect(quarantinePack("cs_legacy_changed", "pi_legacy_changed")).rejects.toThrow(
      "immutable pack authority",
    );
    await dbWrite.execute(sql`UPDATE credit_packs SET is_active = false WHERE id = ${PACK_A}`);
    await expect(quarantinePack("cs_legacy_inactive", "pi_legacy_inactive")).rejects.toThrow(
      "immutable pack authority",
    );
    await dbWrite.execute(sql`DELETE FROM credit_packs WHERE id = ${PACK_A}`);
    await expect(quarantinePack("cs_legacy_deleted", "pi_legacy_deleted")).rejects.toThrow(
      "immutable pack authority",
    );
    const quarantined = await sqlRows<{ checkout_session_id: string; reason: string }>(
      dbWrite,
      sql`SELECT checkout_session_id, reason FROM stripe_checkout_legacy_quarantine ORDER BY checkout_session_id`,
    );
    expect(quarantined).toHaveLength(3);
    expect(quarantined.every((row) => row.reason.includes("immutable"))).toBe(true);
    expect((await rows()).credits).toHaveLength(1);
  });

  test("legacy cutover rejects a cross-tenant user before grant or quarantine", async () => {
    const crossTenant = (purchaseType: "custom_amount" | "credit_pack") =>
      service.settleLegacy({
        checkoutSessionId: `cs_cross_tenant_${purchaseType}`,
        paymentIntentId: `pi_cross_tenant_${purchaseType}`,
        paymentStatus: "paid",
        amountTotal: 500,
        currency: "usd",
        customerId: "cus_a",
        organizationId: ORG_A,
        initiatedByUserId: USER_B,
        purchaseType,
        creditPackId: purchaseType === "credit_pack" ? PACK_A : null,
        claimedCredits: purchaseType === "credit_pack" ? "25.00" : "5.00",
      });

    await expect(crossTenant("custom_amount")).rejects.toThrow("user tenant");
    await expect(crossTenant("credit_pack")).rejects.toThrow("user tenant");

    const state = await rows();
    expect(state.credits).toHaveLength(0);
    expect(state.balances.map((row) => row.credit_balance)).toEqual(["0.000000", "0.000000"]);
    const quarantined = await sqlRows<{ count: string }>(
      dbWrite,
      sql`SELECT count(*)::text AS count FROM stripe_checkout_legacy_quarantine`,
    );
    expect(quarantined[0]?.count).toBe("0");
  });

  test("legacy pack quarantine accepts only an exact replay", async () => {
    const base = {
      checkoutSessionId: "cs_legacy_replay",
      paymentIntentId: "pi_legacy_replay",
      paymentStatus: "paid",
      amountTotal: 500,
      currency: "usd",
      customerId: "cus_a",
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      purchaseType: "credit_pack",
      creditPackId: PACK_A,
      claimedCredits: "25.00",
    } as const;
    await expect(service.settleLegacy(base)).rejects.toThrow("immutable pack authority");
    await expect(service.settleLegacy(base)).rejects.toThrow("immutable pack authority");
    await expect(service.settleLegacy({ ...base, paymentIntentId: "pi_changed" })).rejects.toThrow(
      "quarantine replay",
    );
    await expect(service.settleLegacy({ ...base, amountTotal: 600 })).rejects.toThrow(
      "quarantine replay",
    );
    await expect(
      service.settleLegacy({
        ...base,
        organizationId: ORG_B,
        initiatedByUserId: USER_B,
        customerId: "cus_b",
      }),
    ).rejects.toThrow("quarantine replay");
    const quarantined = await sqlRows<{
      stripe_payment_intent_id: string;
      organization_id: string;
      charge_amount_cents: string;
    }>(
      dbWrite,
      sql`SELECT stripe_payment_intent_id, organization_id, charge_amount_cents::text
          FROM stripe_checkout_legacy_quarantine`,
    );
    expect(quarantined).toEqual([
      {
        stripe_payment_intent_id: "pi_legacy_replay",
        organization_id: ORG_A,
        charge_amount_cents: "500",
      },
    ]);
  });
});

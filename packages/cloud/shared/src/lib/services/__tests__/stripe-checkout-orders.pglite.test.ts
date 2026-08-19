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
    CREATE TABLE users (id uuid PRIMARY KEY);
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
      currency text NOT NULL, stripe_customer_id text NOT NULL,
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
  `);
});

afterAll(async () => closeDb());

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM stripe_checkout_orders`);
  await dbWrite.execute(sql`DELETE FROM credit_transactions`);
  await dbWrite.execute(sql`DELETE FROM credit_packs`);
  await dbWrite.execute(sql`DELETE FROM users`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(
    sql.raw(`INSERT INTO organizations (id, name, slug, stripe_customer_id) VALUES
    ('${ORG_A}', 'A', 'a', 'cus_a'), ('${ORG_B}', 'B', 'b', 'cus_b')`),
  );
  await dbWrite.execute(sql.raw(`INSERT INTO users (id) VALUES ('${USER_A}'), ('${USER_B}')`));
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

  test("legacy cutover derives grants from Stripe cents or the active pack catalog", async () => {
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

    const pack = await service.settleLegacy({
      checkoutSessionId: "cs_legacy_pack",
      paymentIntentId: "pi_legacy_pack",
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
    expect(pack).toMatchObject({ creditsToGrant: "25.000000", newBalance: 30 });
    await expect(
      service.settleLegacy({
        checkoutSessionId: "cs_legacy_hostile",
        paymentIntentId: "pi_legacy_hostile",
        paymentStatus: "paid",
        amountTotal: 500,
        currency: "usd",
        customerId: "cus_a",
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        purchaseType: "credit_pack",
        creditPackId: PACK_A,
        claimedCredits: "9999",
      }),
    ).rejects.toThrow("claimed credits");
    expect((await rows()).credits).toHaveLength(2);
  });
});

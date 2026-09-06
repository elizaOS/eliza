/**
 * Proves the interactive Stripe Checkout route validates the server catalog and emits only order linkage.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const PACK_ID = "40000000-0000-4000-8000-000000000001";
const getCreditPackById = mock(async () => ({
  id: PACK_ID,
  credits: "25.00",
  price_cents: 500,
  stripe_price_id: "price_pack",
  is_active: true,
}));
const priceRetrieve = mock(async () => ({
  id: "price_pack",
  active: true,
  currency: "usd",
  unit_amount: 500,
  recurring: null,
}));
const sessionCreate = mock(
  async (
    params: Record<string, unknown>,
    _options?: { idempotencyKey?: string },
  ) => ({
    id: "cs_pack",
    url: "https://checkout.stripe.test/pack",
    params,
  }),
);
const createOrder = mock(async () => ({
  id: "30000000-0000-4000-8000-000000000001",
  status: "quoted",
  purchase_type: "credit_pack",
  stripe_customer_id: null,
  stripe_checkout_session_id: null,
}));
const bindCustomer = mock(async (orderId: string, customerId: string) => ({
  id: orderId,
  status: "quoted",
  purchase_type: "credit_pack",
  stripe_customer_id: customerId,
  stripe_checkout_session_id: null,
}));
const markProviderStarted = mock(async () => undefined);
const bindSession = mock(async () => undefined);
const ensureStripeCustomer = mock(async () => "cus_a");
const requireUserWithOrg = mock(
  async (): Promise<{
    id: string;
    email: string;
    wallet_address: string | null;
    organization_id: string;
    organization: { stripe_customer_id: string | null; name: string };
  }> => ({
    id: "user-a",
    email: "user@example.test",
    wallet_address: null,
    organization_id: "org-a",
    organization: { stripe_customer_id: "cus_a", name: "Org A" },
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: { getCreditPackById },
}));
mock.module("@/lib/services/organizations", () => ({
  organizationsService: { update: mock(async () => undefined) },
}));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: {
    create: createOrder,
    bindCustomer,
    markProviderStarted,
    bindSession,
    markProviderAmbiguous: mock(async () => undefined),
  },
}));
mock.module("@/lib/services/stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: ensureStripeCustomer },
}));
mock.module("@/lib/stripe", () => ({
  isStripeConfigured: () => true,
  requireStripe: () => ({
    prices: { retrieve: priceRetrieve },
    checkout: {
      sessions: {
        create: sessionCreate,
        retrieve: mock(async () => null),
        list: mock(async () => ({ data: [], has_more: false })),
      },
    },
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app, findCheckoutSessionForOrder } = await import("./route");

function request(
  idempotencyKey?: string,
  body: Record<string, unknown> = { creditPackId: PACK_ID },
): Request {
  return new Request("https://api.example.test/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("bounds endlessly advancing reconciliation cursors by one operation deadline", async () => {
  let clock = 0;
  const list = mock(async () => {
    clock += 5_000;
    return {
      data: [{ id: `cs_unique_${clock}` }],
      has_more: true,
    };
  });
  const stripe = { checkout: { sessions: { list } } } as never;

  await expect(
    findCheckoutSessionForOrder(
      stripe,
      {
        id: "30000000-0000-4000-8000-000000000001",
        stripe_customer_id: "cus_a",
        updated_at: new Date("2026-08-21T00:00:00.000Z"),
      },
      () => clock,
    ),
  ).rejects.toThrow(
    "Stripe Checkout reconciliation exceeded its operation deadline",
  );
  expect(list).toHaveBeenCalledTimes(2);
});

beforeEach(() => {
  getCreditPackById.mockClear();
  priceRetrieve.mockClear();
  sessionCreate.mockClear();
  createOrder.mockClear();
  bindCustomer.mockClear();
  markProviderStarted.mockClear();
  bindSession.mockClear();
  ensureStripeCustomer.mockClear();
  ensureStripeCustomer.mockResolvedValue("cus_a");
  requireUserWithOrg.mockClear();
  requireUserWithOrg.mockResolvedValue({
    id: "user-a",
    email: "user@example.test",
    wallet_address: null,
    organization_id: "org-a",
    organization: { stripe_customer_id: "cus_a", name: "Org A" },
  });
  priceRetrieve.mockImplementation(async () => ({
    id: "price_pack",
    active: true,
    currency: "usd",
    unit_amount: 500,
    recurring: null,
  }));
});

describe("Stripe credit Checkout authority", () => {
  test("rejects a changed checkout principal before any durable or provider work", async () => {
    requireUserWithOrg.mockResolvedValueOnce({
      id: "user-b",
      email: "other@example.test",
      wallet_address: null,
      organization_id: "org-b",
      organization: { stripe_customer_id: "cus_b", name: "Org B" },
    });

    const response = await app.fetch(
      request("principal-switch-request-1", {
        amount: 25,
        expectedUserId: "user-a",
        expectedOrganizationId: "org-a",
      }),
      { STRIPE_CURRENCY: "usd" },
    );

    expect(response.status).toBe(409);
    const responseBody = (await response.json()) as {
      code?: string;
      error?: string;
    };
    expect(responseBody).toEqual({
      code: "CHECKOUT_PRINCIPAL_CHANGED",
      error: "Checkout identity changed; refresh before retrying",
    });
    expect(getCreditPackById).not.toHaveBeenCalled();
    expect(priceRetrieve).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    expect(ensureStripeCustomer).not.toHaveBeenCalled();
    expect(markProviderStarted).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("rejects a partial principal precondition before any checkout work", async () => {
    const response = await app.fetch(
      request("partial-principal-request-1", {
        amount: 25,
        expectedUserId: "user-a",
      }),
      { STRIPE_CURRENCY: "usd" },
    );

    expect(response.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
    expect(ensureStripeCustomer).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("requires client idempotency before reading catalog or calling Stripe", async () => {
    const response = await app.fetch(request(), { STRIPE_CURRENCY: "usd" });
    expect(response.status).toBe(400);
    expect(getCreditPackById).not.toHaveBeenCalled();
    expect(priceRetrieve).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("fails closed when Stripe Price differs from the server catalog", async () => {
    priceRetrieve.mockImplementationOnce(async () => ({
      id: "price_pack",
      active: true,
      currency: "usd",
      unit_amount: 499,
      recurring: null,
    }));
    const response = await app.fetch(request("pack-checkout-request-1"), {
      STRIPE_CURRENCY: "usd",
    });
    expect(response.status).toBe(503);
    expect(createOrder).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("rejects a stale provider Price ID with a structured provider error", async () => {
    // A deleted/missing Stripe price throws from prices.retrieve; the route
    // boundary must translate it through failureResponse — never a raw
    // unstructured body (#22963).
    priceRetrieve.mockImplementationOnce(async () => {
      throw new Error("No such price: price_pack");
    });
    const response = await app.fetch(request("pack-stale-price-1"), {
      STRIPE_CURRENCY: "usd",
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      success?: boolean;
      error?: string;
      code?: string;
    };
    // Structured translation contract: the legacy-error heuristic maps this
    // unknown provider failure to 500/internal_error with the canonical
    // sanitized message — no portion of the provider text may reach the
    // client, so pin the exact message, not just substring absence (#22963).
    expect(body).toEqual({
      success: false,
      error: "An unexpected error occurred",
      code: "internal_error",
    });
    expect(createOrder).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
    // The ambiguous-provider record is only written after an order exists; a
    // pre-order catalog failure must not fabricate durable state.
    expect(markProviderStarted).not.toHaveBeenCalled();
  });

  test("rejects an inactive credit pack before provider work", async () => {
    getCreditPackById.mockImplementationOnce(async () => ({
      id: PACK_ID,
      credits: "25.00",
      price_cents: 500,
      stripe_price_id: "price_pack",
      is_active: false,
    }));
    const response = await app.fetch(request("pack-inactive-1"), {
      STRIPE_CURRENCY: "usd",
    });
    expect(response.status).toBe(404);
    expect(priceRetrieve).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("binds exact pack authority and sends no tenant or grant metadata", async () => {
    const response = await app.fetch(
      request("pack-checkout-request-2", {
        creditPackId: PACK_ID,
        expectedUserId: "user-a",
        expectedOrganizationId: "org-a",
      }),
      { STRIPE_CURRENCY: "usd" },
    );
    expect(response.status).toBe(200);
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestKey: "pack-checkout-request-2",
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        purchaseType: "credit_pack",
        creditPackId: PACK_ID,
        creditsToGrant: "25.000000",
        chargeAmountCents: 500,
        currency: "usd",
      }),
    );
    const params = sessionCreate.mock.calls[0]?.[0] as {
      client_reference_id?: string;
      line_items?: unknown[];
      metadata?: Record<string, string>;
    };
    expect(params.client_reference_id).toBe(
      "30000000-0000-4000-8000-000000000001",
    );
    expect(params.line_items).toEqual([{ price: "price_pack", quantity: 1 }]);
    expect(params.metadata).toEqual({
      checkout_order_id: "30000000-0000-4000-8000-000000000001",
      type: "credit_pack",
    });
    // Exact-pack authority must reuse the same durable Stripe idempotency key
    // as the custom path so a provider retry cannot double-charge (#22963).
    expect(sessionCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: "checkout-order:30000000-0000-4000-8000-000000000001",
    });
    expect(bindSession).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000001",
      "cs_pack",
    );
    expect(bindCustomer).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000001",
      "cus_a",
    );
  });

  test("concurrent no-customer retries use the shared durable customer authority", async () => {
    requireUserWithOrg.mockResolvedValue({
      id: "user-a",
      email: "user@example.test",
      wallet_address: null,
      organization_id: "org-a",
      organization: { stripe_customer_id: null, name: "Org A" },
    });
    ensureStripeCustomer.mockResolvedValue("cus_race_winner");
    const responses = await Promise.all([
      app.fetch(request("pack-customer-race-1"), { STRIPE_CURRENCY: "usd" }),
      app.fetch(request("pack-customer-race-1"), { STRIPE_CURRENCY: "usd" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(ensureStripeCustomer).toHaveBeenCalledTimes(2);
    expect(ensureStripeCustomer).toHaveBeenCalledWith({
      organizationId: "org-a",
      callerIntent: "interactive_checkout",
    });
    expect(
      sessionCreate.mock.calls.every(
        (call) =>
          (call[0] as { customer?: string }).customer === "cus_race_winner",
      ),
    ).toBe(true);
  });

  test("enforces the canonical checkout bounds at both edges and between them (#22963)", async () => {
    // Every case derives its expectation from the shared contract, not from a
    // restated literal, so a deliberate contract change fails here loudly.
    const { ORGANIZATION_CREDIT_CHECKOUT_LIMITS } = await import(
      "@elizaos/cloud-shared/billing"
    );
    const min = ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd;
    const max = ORGANIZATION_CREDIT_CHECKOUT_LIMITS.maxAmountUsd;

    const accepted = [
      min,
      max,
      min + 0.5, // exact cents between the bounds
      max - 0.01,
    ];
    for (const amount of accepted) {
      createOrder.mockClear();
      sessionCreate.mockClear();
      const response = await app.fetch(
        request(`bounds-accepted-${amount}`, { amount }),
        { STRIPE_CURRENCY: "usd" },
      );
      expect(response.status).toBe(200);
      const params = sessionCreate.mock.calls[0]?.[0] as {
        line_items?: Array<{ price_data?: { unit_amount?: number } }>;
      };
      expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(
        Math.round(amount * 100),
      );
    }

    const rejected = [
      min - 0.01,
      max + 0.01,
      0,
      -5,
      // NaN and Infinity cannot survive JSON serialization (they arrive as
      // null), so the non-finite class is asserted as an explicit null case.
    ];
    for (const amount of rejected) {
      createOrder.mockClear();
      sessionCreate.mockClear();
      const response = await app.fetch(
        request(`bounds-rejected-${String(amount)}`, { amount }),
        { STRIPE_CURRENCY: "usd" },
      );
      // Out-of-range custom amounts are deterministic schema rejections; a
      // 500 here would mean validation moved past the boundary into provider
      // work, which the money path must never allow (#22963).
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect((body.error ?? "").length).toBeGreaterThan(0);
      expect(createOrder).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    }

    createOrder.mockClear();
    sessionCreate.mockClear();
    const nullAmount = await app.fetch(
      request("bounds-null-amount", { amount: null }),
      {
        STRIPE_CURRENCY: "usd",
      },
    );
    expect(nullAmount.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  test("rejects sub-cent amounts that cannot resolve to exact whole cents (#22963)", async () => {
    for (const amount of [1.001, 1000.999, 10.005, 250.007]) {
      createOrder.mockClear();
      sessionCreate.mockClear();
      const response = await app.fetch(
        request(`subcent-rejected-${String(amount)}`, { amount }),
        { STRIPE_CURRENCY: "usd" },
      );
      expect(response.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    }
  });

  test("accepts decimal amounts whose float product is noisy but cent-exact (#22963)", async () => {
    // 1.15 * 100 === 114.99999999999999 in binary floating point; a naive
    // safe-integer guard on the product rejects these VALID card amounts.
    // The decimal-safe conversion must accept them and charge exact cents.
    for (const [amount, expectedCents] of [
      [1.15, 115],
      [4.35, 435],
      [19.99, 1999],
      [8.07, 807],
    ] as const) {
      createOrder.mockClear();
      sessionCreate.mockClear();
      const response = await app.fetch(
        request(`float-cent-accepted-${String(amount)}`, { amount }),
        { STRIPE_CURRENCY: "usd" },
      );
      expect(response.status).toBe(200);
      const params = sessionCreate.mock.calls[0]?.[0] as {
        line_items?: Array<{ price_data?: { unit_amount?: number } }>;
      };
      expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(
        expectedCents,
      );
      expect(createOrder).toHaveBeenCalledWith(
        expect.objectContaining({ chargeAmountCents: expectedCents }),
      );
    }
  });

  test("rejects non-null wrong-typed amount values before any order or provider work (#22963)", async () => {
    for (const [label, amount] of [
      ["string", "5"],
      ["object", {}],
      ["array", []],
    ] as const) {
      createOrder.mockClear();
      sessionCreate.mockClear();
      const response = await app.fetch(
        request(`wrong-type-amount-${label}`, { amount }),
        { STRIPE_CURRENCY: "usd" },
      );
      expect(response.status).toBe(400);
      expect(createOrder).not.toHaveBeenCalled();
      expect(sessionCreate).not.toHaveBeenCalled();
    }
  });
});

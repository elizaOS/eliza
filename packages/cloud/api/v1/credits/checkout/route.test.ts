/** Exercises v1 credit Checkout authority with deterministic Worker route fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
const checkoutCreate = mock(
  async (
    params: Record<string, unknown>,
    _options?: { idempotencyKey?: string },
  ) => ({
    id: "cs_agent_checkout",
    url: "https://checkout.stripe.test/session",
    params,
  }),
);
const checkoutList = mock(async () => ({
  data: [] as Array<Record<string, unknown>>,
  has_more: false,
}));
const validateServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));
const requireUserOrApiKeyWithOrg = mock(async () => {
  throw new Error(
    "interactive auth should not be used for service agent checkout",
  );
});
const updateOrganization = mock(async () => undefined);
const ensureStripeCustomer = mock(async () => "cus_created");
const createOrder = mock(
  async (): Promise<{
    id: string;
    status: string;
    stripe_customer_id: string | null;
    updated_at?: Date;
  }> => ({
    id: "30000000-0000-4000-8000-000000000001",
    status: "quoted",
    stripe_customer_id: null,
  }),
);
const bindCustomer = mock(async (orderId: string, customerId: string) => ({
  id: orderId,
  status: "quoted",
  stripe_customer_id: customerId,
}));
const markProviderStarted = mock(async () => undefined);
const bindSession = mock(async () => undefined);
const markProviderAmbiguous = mock(async () => undefined);
const getWithOrganization = mock(
  async (): Promise<{
    id: string;
    email: string;
    wallet_address: string | null;
    organization_id: string;
    organization: {
      id: string;
      name: string;
      stripe_customer_id: string | null;
      billing_email: string | null;
      is_active: boolean;
    };
  }> => ({
    id: "agent-user",
    email: "agent@example.test",
    wallet_address: "0x0000000000000000000000000000000000000001",
    organization_id: "agent-org",
    organization: {
      id: "agent-org",
      name: "Agent Org",
      stripe_customer_id: "cus_agent",
      billing_email: "billing@example.test",
      is_active: true,
    },
  }),
);

function dbChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
}

const dbRead = {
  select: mock(() =>
    dbChain([{ organizationId: "agent-org", userId: "agent-user" }]),
  ),
};

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  validateServiceKey,
  requireServiceKey: validateServiceKey,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/db/helpers", () => ({
  dbRead,
}));

mock.module("@/lib/services/users", () => ({
  usersService: {
    getWithOrganization,
  },
}));

mock.module("@/lib/services/organizations", () => ({
  organizationsService: {
    update: updateOrganization,
  },
}));

mock.module("@/lib/services/stripe-checkout-orders", () => ({
  stripeCheckoutOrdersService: {
    create: createOrder,
    bindCustomer,
    markProviderStarted,
    bindSession,
    markProviderAmbiguous,
  },
}));
mock.module("@/lib/services/stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: ensureStripeCustomer },
}));

mock.module("@/lib/security/redirect-validation", () => ({
  getDefaultPlatformRedirectOrigins: () => ["https://waifu.example.test"],
  assertAllowedAbsoluteRedirectUrl: (url: string) => new URL(url),
}));

mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: {
      sessions: {
        create: checkoutCreate,
        list: checkoutList,
      },
    },
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    STANDARD: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: app } = await import("./route");

describe("credits checkout service-key agent bridge", () => {
  beforeEach(() => {
    checkoutCreate.mockClear();
    checkoutList.mockClear();
    createOrder.mockClear();
    bindCustomer.mockClear();
    markProviderStarted.mockClear();
    bindSession.mockClear();
    validateServiceKey.mockClear();
    requireUserOrApiKeyWithOrg.mockClear();
    updateOrganization.mockClear();
    ensureStripeCustomer.mockClear();
    ensureStripeCustomer.mockImplementation(async () => "cus_agent");
    getWithOrganization.mockClear();
    dbRead.select.mockClear();
  });

  test("creates an organization checkout for the agent owner org", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-request-1",
        },
        body: JSON.stringify({
          credits: 5,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      url: "https://checkout.stripe.test/session",
      sessionId: "cs_agent_checkout",
    });
    expect(validateServiceKey).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(checkoutCreate).toHaveBeenCalledTimes(1);
    const params = checkoutCreate.mock.calls[0]?.[0] as {
      customer?: string;
      metadata?: Record<string, string>;
    };
    expect(params.customer).toBe("cus_agent");
    expect(params.metadata).toEqual({
      checkout_order_id: "30000000-0000-4000-8000-000000000001",
      agent_id: agentId,
    });
    expect(checkoutCreate.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: "checkout-order:30000000-0000-4000-8000-000000000001",
    });
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "agent-org",
        initiatedByUserId: "agent-user",
        clientRequestKey: "agent-checkout-request-1",
        creditsToGrant: "5.000000",
        chargeAmountCents: 500,
        currency: "usd",
      }),
    );
  });

  test("grants one USD-denominated credit for a one-dollar checkout", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-usd-1",
        },
        body: JSON.stringify({
          amountUsd: 1,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        creditsToGrant: "1.000000",
        chargeAmountCents: 100,
        currency: "usd",
      }),
    );
    const createParams = checkoutCreate.mock.calls[0]?.[0];
    if (!createParams) throw new Error("Stripe Checkout was not invoked");
    const lineItems = (
      createParams as {
        line_items?: Array<{ price_data?: { unit_amount?: number } }>;
      }
    ).line_items;
    expect(lineItems?.[0]?.price_data?.unit_amount).toBe(100);
  });

  test("rejects conflicting canonical and compatibility amounts", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-unit-conflict",
        },
        body: JSON.stringify({
          amountUsd: 1,
          credits: 100,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  test("recovers an ambiguous provider response without creating another session", async () => {
    const orderId = "30000000-0000-4000-8000-000000000001";
    createOrder.mockImplementationOnce(async () => ({
      id: orderId,
      status: "provider_ambiguous",
      stripe_customer_id: "cus_order_winner",
      updated_at: new Date(),
    }));
    ensureStripeCustomer.mockResolvedValueOnce("cus_order_winner");
    checkoutList.mockImplementationOnce(async () => ({
      data: [
        {
          id: "cs_recovered",
          url: "https://checkout.stripe.test/recovered",
          client_reference_id: orderId,
          metadata: { checkout_order_id: orderId },
        },
      ],
      has_more: false,
    }));
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-request-2",
        },
        body: JSON.stringify({
          credits: 5,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.test/recovered",
      sessionId: "cs_recovered",
    });
    expect(bindSession).toHaveBeenCalledWith(orderId, "cs_recovered");
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect(checkoutList).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_order_winner" }),
    );
    expect(markProviderStarted).not.toHaveBeenCalled();
  });

  test("reconciles beyond the former ten-page Stripe search ceiling", async () => {
    const orderId = "30000000-0000-4000-8000-000000000001";
    createOrder.mockImplementationOnce(async () => ({
      id: orderId,
      status: "provider_ambiguous",
      stripe_customer_id: "cus_order_winner",
      updated_at: new Date(),
    }));
    ensureStripeCustomer.mockResolvedValueOnce("cus_order_winner");
    checkoutList.mockImplementation(async () => {
      const page = checkoutList.mock.calls.length;
      return {
        data: [
          page === 11
            ? {
                id: "cs_recovered_late",
                url: "https://checkout.stripe.test/recovered-late",
                client_reference_id: orderId,
                metadata: { checkout_order_id: orderId },
              }
            : { id: `cs_unrelated_${page}` },
        ],
        has_more: page < 11,
      };
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-request-late-recovery",
        },
        body: JSON.stringify({
          credits: 5,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(checkoutList).toHaveBeenCalledTimes(11);
    const checkoutCalls = checkoutList.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(checkoutCalls[10]?.[0]).toMatchObject({
      starting_after: "cs_unrelated_10",
    });
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.stripe.test/recovered-late",
      sessionId: "cs_recovered_late",
    });
  });

  test("uses shared durable customer authority when the organization is unbound", async () => {
    ensureStripeCustomer.mockResolvedValueOnce("cus_created");
    getWithOrganization.mockImplementationOnce(async () => ({
      id: "agent-user",
      email: "agent@example.test",
      wallet_address: null,
      organization_id: "agent-org",
      organization: {
        id: "agent-org",
        name: "Agent Org",
        stripe_customer_id: null,
        billing_email: null,
        is_active: true,
      },
    }));
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Service-Key": "svc",
          "Idempotency-Key": "agent-checkout-request-3",
        },
        body: JSON.stringify({
          credits: 5,
          agent_id: agentId,
          success_url: "https://waifu.example.test/success",
          cancel_url: "https://waifu.example.test/cancel",
        }),
      }),
      { WAIFU_SERVICE_KEY: "svc" },
    );
    expect(response.status).toBe(200);
    expect(ensureStripeCustomer).toHaveBeenCalledWith({
      organizationId: "agent-org",
      callerIntent: "credit_checkout",
    });
    expect(bindCustomer).toHaveBeenCalledWith(
      "30000000-0000-4000-8000-000000000001",
      "cus_created",
    );
  });
});

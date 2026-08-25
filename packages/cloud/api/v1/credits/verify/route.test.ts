/**
 * Proves the v1 verification compatibility route settles through durable or validated legacy authority.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const retrieveSession = mock(
  async (): Promise<Record<string, unknown>> => ({
    id: "cs_durable",
    client_reference_id: "order-a",
    payment_status: "paid",
    amount_total: 500,
    currency: "usd",
    customer: "cus_a",
    payment_intent: { id: "pi_a" },
    metadata: { checkout_order_id: "order-a" },
  }),
);
const settle = mock(async () => ({
  order: { credits_to_grant: "25.000000" },
  alreadyApplied: false,
  newBalance: 25,
}));
const settleLegacy = mock(async () => ({
  organizationId: "org-a",
  initiatedByUserId: "user-a",
  purchaseType: "custom_amount",
  creditsToGrant: "5.000000",
  alreadyApplied: false,
  newBalance: 5,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-a",
    organization_id: "org-a",
  })),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
  StripeCheckoutAuthorityError: class extends Error {
    code = "test";
  },
  stripeCheckoutOrdersService: { settle, settleLegacy },
}));
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    checkout: { sessions: { retrieve: retrieveSession } },
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

const { default: app } = await import("./route");

beforeEach(() => {
  retrieveSession.mockClear();
  settle.mockClear();
  settleLegacy.mockClear();
});

describe("v1 credits verification authority", () => {
  test("settles a durable order with authenticated tenant binding", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/?session_id=cs_durable"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      amount: 25,
    });
    expect(settle).toHaveBeenCalledWith(
      {
        checkoutOrderId: "order-a",
        clientReferenceId: "order-a",
        metadataOrderId: "order-a",
        checkoutSessionId: "cs_durable",
        paymentIntentId: "pi_a",
        paymentStatus: "paid",
        amountTotal: 500,
        currency: "usd",
        customerId: "cus_a",
      },
      { callerOrganizationId: "org-a", callerUserId: "user-a" },
    );
    expect(settleLegacy).not.toHaveBeenCalled();
  });

  test("uses the validated cutover for a pre-deploy session", async () => {
    retrieveSession.mockImplementationOnce(async () => ({
      id: "cs_legacy",
      payment_status: "paid",
      amount_total: 500,
      currency: "usd",
      customer: "cus_a",
      payment_intent: { id: "pi_legacy" },
      metadata: {
        organization_id: "org-a",
        user_id: "user-a",
        type: "custom_amount",
        credits: "5.00",
      },
    }));
    const response = await app.fetch(
      new Request("https://api.example.test/?session_id=cs_legacy"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      amount: 5,
    });
    expect(settleLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "cs_legacy",
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        purchaseType: "custom_amount",
        claimedCredits: "5.00",
      }),
      { callerOrganizationId: "org-a", callerUserId: "user-a" },
    );
  });
});

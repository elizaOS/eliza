/**
 * Exercises the payment-request creation boundary with mocked authentication
 * and payment services, proving public callers cannot attach agent identity.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-a",
  organization_id: "org-a",
}));
const createPaymentRequest = mock(async (input: Record<string, unknown>) => ({
  paymentRequest: {
    id: "payment-request-a",
    organizationId: input.organizationId,
    agentId: null,
  },
  hostedUrl: "https://pay.example/request-a",
}));
const listPaymentRequests = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({
    create: createPaymentRequest,
    list: listPaymentRequests,
  }),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { default: paymentRequestsRoute } = await import("./route");
const app = new Hono();
app.route("/api/v1/payment-requests", paymentRequestsRoute);

function createRequest(body: Record<string, unknown> = {}): Request {
  return new Request("https://api.example.test/api/v1/payment-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "oxapay",
      amountCents: 100,
      paymentContext: "any_payer",
      ...body,
    }),
  });
}

describe("POST /api/v1/payment-requests agent identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-a",
      organization_id: "org-a",
    });
    createPaymentRequest.mockReset();
    createPaymentRequest.mockResolvedValue({
      paymentRequest: {
        id: "payment-request-a",
        organizationId: "org-a",
        agentId: null,
      },
      hostedUrl: "https://pay.example/request-a",
    });
  });

  test("creates a payment request when agent identity is omitted", async () => {
    const response = await app.fetch(createRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(createPaymentRequest).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
  });

  test("rejects agent identity before creating a provider intent", async () => {
    const response = await app.fetch(
      createRequest({ agentId: "00000000-0000-4000-8000-000000000001" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request",
    });
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  test("rejects unsupported payer claims and the first out-of-range ledger cent", async () => {
    for (const body of [
      { paymentContext: "verified_payer" },
      { amountCents: 100_000_000 },
      { currency: "JPY" },
    ]) {
      const response = await app.fetch(createRequest(body));
      expect(response.status).toBe(400);
    }
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });
});

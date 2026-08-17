/**
 * GET /api/v1/payment-requests/:id `public` is checkout-visibility identity,
 * not leftover Life Ops inbox bool tax. Stock develop treated only the exact
 * token `1` as the unauthenticated checkout DTO; `public=true` / `public=yes`
 * silently took the authenticated creator path.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getMock = mock(
  async (
    _id: string,
    _organizationId: string,
  ): Promise<PaymentRequestRow | null> => null,
);
const getPublicMock = mock(
  async (_id: string): Promise<PaymentRequestRow | null> => null,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({
    get: getMock,
    getPublic: getPublicMock,
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    _error: unknown,
  ) => c.json({ success: false, error: "internal error" }, 500),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined) },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

const paymentRequest: PaymentRequestRow = {
  id: "pr-1",
  organizationId: "org-1",
  agentId: "agent-1",
  appId: "app-1",
  provider: "stripe" as const,
  amountCents: 2500,
  currency: "USD",
  reason: "Premium plan",
  paymentContext: { kind: "any_payer" as const },
  payerIdentityId: "payer-identity-1",
  payerUserId: "payer-user-1",
  payerOrganizationId: "payer-org-1",
  status: "pending" as const,
  hostedUrl: "https://checkout.example.test/session",
  callbackUrl: "https://merchant.example.test/callback",
  callbackSecret: "callback-secret",
  providerIntent: { secretSessionId: "provider-secret" },
  settledAt: null,
  settlementTxRef: "provider-tx-ref",
  settlementProof: { signature: "proof-secret" },
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: { internal: "do-not-expose" },
};

function expectNoLookup() {
  expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(getMock).not.toHaveBeenCalled();
  expect(getPublicMock).not.toHaveBeenCalled();
}

describe("GET /api/v1/payment-requests/:id public checkout identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getMock.mockClear();
    getPublicMock.mockClear();
    getMock.mockResolvedValue(paymentRequest);
    getPublicMock.mockResolvedValue(paymentRequest);
  });

  test.each(["", "?public="])(
    "accepts %s as the authenticated creator view",
    async (query) => {
      const response = await app.request(`/pr-1${query}`);
      expect(response.status).toBe(200);
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
      expect(getMock).toHaveBeenCalledWith("pr-1", "org-1");
      expect(getPublicMock).not.toHaveBeenCalled();
    },
  );

  test("accepts public=1 as the unauthenticated checkout DTO", async () => {
    const response = await app.request("/pr-1?public=1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      paymentRequest: { id: string; hostedUrl: string };
    };
    expect(body.success).toBe(true);
    expect(body.paymentRequest.id).toBe("pr-1");
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getPublicMock).toHaveBeenCalledWith("pr-1");
    expect(getMock).not.toHaveBeenCalled();
  });

  test.each(["true", "yes", "TRUE", "0", "foo", "1e2"])(
    "rejects public=%s before checkout or creator lookup",
    async (token) => {
      const response = await app.request(
        `/pr-1?public=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/public/i);
      expectNoLookup();
    },
  );
});

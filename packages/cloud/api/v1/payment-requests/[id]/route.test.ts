/**
 * Exercises the payment-request single-resource route with mocked service and
 * auth boundaries, covering the public checkout DTO and tenant scoping.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getMock = mock(async (_id: string, _organizationId: string) => null);
const getPublicMock = mock(async (_id: string) => null);
const getPaymentRequestsService = mock(() => ({
  get: getMock,
  getPublic: getPublicMock,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ success: false, error: "internal error" }, status),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

const paymentRequest = {
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
  expiresAt: new Date("2026-08-12T12:00:00.000Z"),
  createdAt: new Date("2026-08-12T11:00:00.000Z"),
  updatedAt: new Date("2026-08-12T11:00:00.000Z"),
  metadata: { internal: "do-not-expose" },
};

describe("GET /api/v1/payment-requests/:id", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getMock.mockClear();
    getPublicMock.mockClear();
    getMock.mockResolvedValue(null);
    getPublicMock.mockResolvedValue(null);
  });

  test("returns only the public checkout DTO without internal fields", async () => {
    getPublicMock.mockResolvedValue(paymentRequest);

    const response = await app.request("/pr-1?public=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      paymentRequest: {
        id: "pr-1",
        provider: "stripe",
        amountCents: 2500,
        currency: "USD",
        reason: "Premium plan",
        status: "pending",
        hostedUrl: "https://checkout.example.test/session",
        expiresAt: "2026-08-12T12:00:00.000Z",
      },
    });
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    expect(getPublicMock).toHaveBeenCalledWith("pr-1");
  });

  test("returns not found for a missing public payment request without authenticating", async () => {
    const response = await app.request("/missing?public=1");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Payment request not found",
    });
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getPublicMock).toHaveBeenCalledWith("missing");
  });

  test("scopes authenticated reads to the caller organization", async () => {
    getMock.mockResolvedValue(paymentRequest);

    const response = await app.request("/pr-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      paymentRequest,
    });
    expect(getMock).toHaveBeenCalledWith("pr-1", "org-1");
    expect(getPublicMock).not.toHaveBeenCalled();
  });

  test("does not return a payment request from another organization", async () => {
    const response = await app.request("/pr-1");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Payment request not found",
    });
    expect(getMock).toHaveBeenCalledWith("pr-1", "org-1");
  });
});

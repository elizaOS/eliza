/**
 * Exercises the payment-request single-resource route with mocked service and
 * auth boundaries, covering the public checkout DTO and tenant scoping.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";
import {
  expectedPaymentRequestDto,
  INTERNAL_PAYMENT_REQUEST_CANARIES,
  paymentRequestRow,
} from "../payment-request-route-test-fixtures";

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
  failureResponse: (
    c: { json: (body: unknown, status: number) => Response },
    _error: unknown,
  ) => c.json({ success: false, error: "internal error" }, 500),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

const paymentRequest = paymentRequestRow();

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
        expiresAt: paymentRequest.expiresAt.toISOString(),
      },
    });
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
    expect(getPublicMock).toHaveBeenCalledWith("pr-1");
  });

  test("derives expiration and removes the stale public checkout URL", async () => {
    getPublicMock.mockResolvedValue({
      ...paymentRequest,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await app.request("/pr-1?public=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      paymentRequest: {
        status: "expired",
        hostedUrl: null,
      },
    });
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
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      paymentRequest: expectedPaymentRequestDto(paymentRequest),
    });
    const serialized = JSON.stringify(body);
    for (const canary of INTERNAL_PAYMENT_REQUEST_CANARIES) {
      expect(serialized).not.toContain(canary);
    }
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

  test("translates service failures at the HTTP boundary", async () => {
    getPublicMock.mockRejectedValue(new Error("database unavailable"));

    const response = await app.request("/pr-1?public=1");

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "internal error",
    });
  });
});

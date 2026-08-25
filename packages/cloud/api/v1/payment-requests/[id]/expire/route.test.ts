/** Exercises the mocked payment-request expire boundary and its constructive creator response. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";
import {
  expectedPaymentRequestDto,
  INTERNAL_PAYMENT_REQUEST_CANARIES,
  paymentRequestRow,
} from "../../payment-request-route-test-fixtures";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getMock = mock(
  async (
    _id: string,
    _organizationId: string,
  ): Promise<PaymentRequestRow | null> => paymentRequestRow(),
);
const expireMock = mock(async (_id: string, _organizationId: string) => ({
  paymentRequest: paymentRequestRow({ status: "expired" }),
  expired: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ get: getMock, expire: expireMock }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: "standard" },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
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
const app = new Hono().route("/:id/expire", route);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  getMock.mockReset();
  getMock.mockResolvedValue(paymentRequestRow());
  expireMock.mockReset();
  expireMock.mockResolvedValue({
    paymentRequest: paymentRequestRow({
      status: "expired",
      updatedAt: new Date("2026-08-20T10:07:00.000Z"),
    }),
    expired: true,
  });
});

describe("POST /api/v1/payment-requests/:id/expire", () => {
  test("returns only the creator DTO and preserves the scoped expiration result", async () => {
    const response = await app.request("/pr-1/expire", { method: "POST" });

    expect(response.status).toBe(200);
    const body = await response.json();
    const row = paymentRequestRow({
      status: "expired",
      updatedAt: new Date("2026-08-20T10:07:00.000Z"),
    });
    expect(body).toEqual({
      success: true,
      paymentRequest: expectedPaymentRequestDto(row),
      expired: true,
    });
    const serialized = JSON.stringify(body);
    for (const canary of INTERNAL_PAYMENT_REQUEST_CANARIES) {
      expect(serialized).not.toContain(canary);
    }
    expect(getMock).toHaveBeenCalledWith("pr-1", "org-1");
    expect(expireMock).toHaveBeenCalledWith("pr-1", "org-1");
  });

  test("does not expire a request outside the caller organization", async () => {
    getMock.mockResolvedValue(null);

    const response = await app.request("/pr-other/expire", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Payment request not found",
    });
    expect(expireMock).not.toHaveBeenCalled();
  });
});

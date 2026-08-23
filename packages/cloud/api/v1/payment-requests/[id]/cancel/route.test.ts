/** Exercises the mocked payment-request cancel boundary and its constructive creator response. */
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
const cancelMock = mock(
  async (
    _id: string,
    _organizationId: string,
    _reason?: string,
  ): Promise<PaymentRequestRow> => paymentRequestRow({ status: "canceled" }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ cancel: cancelMock }),
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
const app = new Hono().route("/:id/cancel", route);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockClear();
  cancelMock.mockReset();
  cancelMock.mockResolvedValue(
    paymentRequestRow({
      status: "canceled",
      updatedAt: new Date("2026-08-20T10:06:00.000Z"),
    }),
  );
});

describe("POST /api/v1/payment-requests/:id/cancel", () => {
  test("returns only the creator DTO and preserves tenant-scoped cancellation", async () => {
    const response = await app.request("/pr-1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No longer needed" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const row = paymentRequestRow({
      status: "canceled",
      updatedAt: new Date("2026-08-20T10:06:00.000Z"),
    });
    expect(body).toEqual({
      success: true,
      paymentRequest: expectedPaymentRequestDto(row),
    });
    const serialized = JSON.stringify(body);
    for (const canary of INTERNAL_PAYMENT_REQUEST_CANARIES) {
      expect(serialized).not.toContain(canary);
    }
    expect(cancelMock).toHaveBeenCalledWith(
      "pr-1",
      "org-1",
      "No longer needed",
    );
  });
});

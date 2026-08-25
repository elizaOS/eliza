/**
 * Exercises the payment-request collection boundary with mocked authentication
 * and services, proving identity validation and constructive response redaction.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";
import {
  expectedPaymentRequestDto,
  INTERNAL_PAYMENT_REQUEST_CANARIES,
  paymentRequestRow,
} from "./payment-request-route-test-fixtures";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-a",
  organization_id: "org-a",
}));
const createPaymentRequest = mock(async (input: Record<string, unknown>) => {
  const row = paymentRequestRow({
    organizationId: String(input.organizationId),
  });
  return {
    paymentRequest: row,
    hostedUrl: row.hostedUrl ?? undefined,
  };
});
const listPaymentRequests = mock(async (): Promise<PaymentRequestRow[]> => []);

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
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
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

function expectNoInternalCanaries(body: unknown): void {
  const serialized = JSON.stringify(body);
  for (const canary of INTERNAL_PAYMENT_REQUEST_CANARIES) {
    expect(serialized).not.toContain(canary);
  }
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-a",
    organization_id: "org-a",
  });
  createPaymentRequest.mockReset();
  const row = paymentRequestRow({ organizationId: "org-a" });
  createPaymentRequest.mockResolvedValue({
    paymentRequest: row,
    hostedUrl: row.hostedUrl ?? undefined,
  });
  listPaymentRequests.mockReset();
  listPaymentRequests.mockResolvedValue([]);
});

describe("POST /api/v1/payment-requests", () => {
  test("creates a payment request and returns only its creator DTO", async () => {
    const response = await app.fetch(createRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    const row = paymentRequestRow({ organizationId: "org-a" });
    expect(body).toEqual({
      success: true,
      paymentRequest: expectedPaymentRequestDto(row),
      hostedUrl: row.hostedUrl,
    });
    expectNoInternalCanaries(body);
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

describe("GET /api/v1/payment-requests", () => {
  test("projects every listed row and preserves the scoped filters", async () => {
    const first = paymentRequestRow({
      id: "pr-list-1",
      status: "settled",
      settledAt: new Date("2026-08-20T10:03:00.000Z"),
    });
    const second = paymentRequestRow({
      id: "pr-list-2",
      agentId: null,
      appId: null,
      status: "settled",
      settledAt: new Date("2026-08-20T10:04:00.000Z"),
    });
    listPaymentRequests.mockResolvedValue([first, second]);

    const response = await app.request(
      "/api/v1/payment-requests?status=settled&provider=stripe&agentId=agent-1&limit=2&offset=1",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      paymentRequests: [
        expectedPaymentRequestDto(first),
        expectedPaymentRequestDto(second),
      ],
    });
    expectNoInternalCanaries(body);
    expect(listPaymentRequests).toHaveBeenCalledWith("org-a", {
      status: "settled",
      provider: "stripe",
      agentId: "agent-1",
      limit: 2,
      offset: 1,
    });
  });
});

/**
 * POST /api/v1/payment-requests must reject metadata or reason values that
 * PostgreSQL text/jsonb cannot store (U+0000, lone surrogates) as a 400 before
 * any service call, instead of letting the insert fail with a 500 (#31769).
 * Real route module with auth, rate limiting and the service mocked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  organizationId: "org-1",
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));
// The route calls `service.create`; the mock throws so a request that reaches
// it is visible as a 500 with exactly one recorded call, never a fabricated
// success.
const createPaymentRequest = mock(async () => {
  throw new Error("service must not be reached");
});
mock.module("@/lib/services/payment-requests-default", () => ({
  getPaymentRequestsService: () => ({ create: createPaymentRequest }),
}));

const { default: route } = await import("../v1/payment-requests/route");
const app = new Hono();
app.route("/api/v1/payment-requests", route);

const NUL = String.fromCharCode(0);
const LONE_HIGH = String.fromCharCode(0xd800);

function post(body: Record<string, unknown>) {
  return app.request(
    "https://api.example.test/api/v1/payment-requests",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { NODE_ENV: "test" },
  );
}

const base = {
  provider: "stripe",
  amountCents: 500,
  paymentContext: "any_payer",
  successUrl: "https://example.test/ok",
  cancelUrl: "https://example.test/cancel",
};

describe("payment-requests unstorable strings", () => {
  beforeEach(() => {
    createPaymentRequest.mockClear();
  });

  test("metadata with U+0000 is a 400 naming the path, not a 500", async () => {
    const response = await post({ ...base, metadata: { note: `x${NUL}` } });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      details: Array<{ path: (string | number)[] }>;
    };
    expect(payload.details[0]?.path).toEqual(["metadata", "note"]);
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  test("metadata with a lone surrogate is a 400", async () => {
    const response = await post({
      ...base,
      metadata: { deep: [{ k: `a${LONE_HIGH}` }] },
    });
    expect(response.status).toBe(400);
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  test("reason with U+0000 is a 400 naming reason", async () => {
    const response = await post({ ...base, reason: `pay${NUL}` });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      details: Array<{ path: (string | number)[] }>;
    };
    expect(payload.details[0]?.path).toEqual(["reason"]);
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });

  test("a large but storable metadata is not reported as unstorable", async () => {
    const response = await post({
      ...base,
      metadata: { ints: Array.from({ length: 40_000 }, (_, i) => i) },
    });
    expect(response.status).not.toBe(400);
    // Validation passed: the request reached the (throwing) service mock once.
    expect(createPaymentRequest).toHaveBeenCalledTimes(1);
  });

  test("metadata over the JSON value bound is a 400 naming the bound, not U+0000", async () => {
    const response = await post({
      ...base,
      metadata: { ints: Array.from({ length: 50_010 }, (_, i) => i) },
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      details: Array<{ path: (string | number)[]; message: string }>;
    };
    expect(payload.details[0]?.path).toEqual(["metadata"]);
    expect(payload.details[0]?.message).toContain("50000");
    expect(payload.details[0]?.message).not.toContain("U+0000");
    expect(createPaymentRequest).not.toHaveBeenCalled();
  });
});

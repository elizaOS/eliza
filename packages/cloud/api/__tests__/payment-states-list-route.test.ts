/**
 * GET /api/v1/billing/payment-states contract tests (#26752 lossless
 * history): offset/limit parsing, the bounded-offset guard, real total
 * (never the page length), hasMore arithmetic, and exact service-argument
 * forwarding. Auth middleware is stubbed to a fixed org; the route module
 * is real; the service is a mock returning real-shaped rows.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as authActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as paymentHistoryActual from "@/lib/services/payment-history";

const ORG_A = "11111111-1111-4111-8111-111111111111";

const sampleRow = (id: string) => ({
  id,
  surface: "checkout_order",
  authorityId: id.split(":")[1] ?? "",
  receiptId: null,
  provider: "stripe",
  amountCents: 2500,
  currency: "USD",
  eventTime: "2026-08-23T12:00:00.000Z",
  eventTimeKind: "provider_settlement",
  paymentState: "succeeded",
  cumulativeRefundedChargeCurrency: 0,
  cumulativeDisputedChargeCurrency: 0,
  cumulativeClawbackCredits: 0,
  reinstatedCredits: 0,
  unrecoveredShortfallCredits: 0,
  disputeReinstated: false,
  policyEffect: null,
  supportState: "none",
});

// Page-shaped fake: rows 0..count-1 keyed "checkout_order:o<i>".
let fakeTotal = 0;
const listPaymentStates = mock(
  async (_organizationId: string, limit: number, offset: number) => {
    const rows: Array<ReturnType<typeof sampleRow>> = [];
    for (let i = offset; i < Math.min(offset + limit, fakeTotal); i++) {
      rows.push(sampleRow(`checkout_order:o${i}`));
    }
    return rows;
  },
);
const countPaymentStates = mock(async () => fakeTotal);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKeyWithOrg: async () => ({
    organization_id: ORG_A,
  }),
}));

mock.module("@/lib/services/payment-history", () => ({
  ...paymentHistoryActual,
  paymentHistoryService: { listPaymentStates, countPaymentStates },
}));

const listRoute = (await import("../v1/billing/payment-states/route")).default;
const app = new Hono().route("/api/v1/billing/payment-states", listRoute);

afterAll(() => {
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/auth/workers-hono-auth", () => authActual);
  mock.module("@/lib/services/payment-history", () => paymentHistoryActual);
});

beforeEach(() => {
  fakeTotal = 0;
  listPaymentStates.mockClear();
  countPaymentStates.mockClear();
});

async function list(query: string) {
  return app.request(`/api/v1/billing/payment-states${query}`, {
    method: "GET",
  });
}

describe("GET /api/v1/billing/payment-states (lossless pagination)", () => {
  test("forwards parsed limit/offset to the service and reports the REAL total", async () => {
    fakeTotal = 240;
    const res = await list("?limit=200&offset=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      states: Array<{ id: string }>;
      total: number;
      offset: number;
      hasMore: boolean;
    };
    expect(body.success).toBe(true);
    expect(listPaymentStates).toHaveBeenCalledWith(ORG_A, 200, 200);
    // total is the org's persisted count, NOT states.length — the page-2
    // response still reports 240.
    expect(body.total).toBe(240);
    expect(body.states.length).toBe(40);
    expect(body.offset).toBe(200);
    expect(body.hasMore).toBe(false);
  });

  test("hasMore is true while pages remain", async () => {
    fakeTotal = 120;
    const res = await list(""); // defaults: limit 50, offset 0
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; hasMore: boolean };
    expect(listPaymentStates).toHaveBeenCalledWith(ORG_A, 50, 0);
    expect(body.total).toBe(120);
    expect(body.hasMore).toBe(true);
  });

  test("rejects non-canonical limit and offset values with 400", async () => {
    for (const bad of [
      "?limit=0",
      "?limit=-5",
      "?limit=abc",
      "?offset=1.5",
      "?offset=-1",
      "?offset=0x10",
    ]) {
      const res = await list(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid");
    }
    expect(listPaymentStates).not.toHaveBeenCalled();
  });

  test("traversal is lossless: offsets beyond the former 10,000 bound are served, not rejected (#26752 P1)", async () => {
    // The former depth cap stranded the history tail: a card holding 10,050
    // rows received hasMore=true, its next request (?offset=10050) hit a
    // permanent 400, and the retry loop could never step past it. The cap is
    // removed — any non-negative integer offset is a valid page request.
    const res = await list("?offset=10050");
    expect(res.status).toBe(200);
    expect(listPaymentStates).toHaveBeenCalledWith(
      expect.anything(),
      50,
      10050,
    );
    const body = (await res.json()) as { success: boolean; offset: number };
    expect(body.success).toBe(true);
    expect(body.offset).toBe(10050);
    // The former boundary itself still works, and far-beyond offsets (an
    // org with very deep history) return an empty page, hasMore=false —
    // a clean end of traversal, never a 400.
    const boundary = await list("?offset=10000");
    expect(boundary.status).toBe(200);
    const past = await list("?offset=20000");
    expect(past.status).toBe(200);
    const pastBody = (await past.json()) as {
      states: unknown[];
      hasMore: boolean;
    };
    expect(pastBody.states).toEqual([]);
    expect(pastBody.hasMore).toBe(false);
  });
});

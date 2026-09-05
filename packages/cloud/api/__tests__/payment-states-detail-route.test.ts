/**
 * GET /api/v1/billing/payment-states/:id contract tests (#22966 linked
 * order/receipt surface): direct org-scoped lookup by the stable
 * `{surface}:{authorityId}` id, 400 on malformed ids, real 404 when no
 * persisted authority row matches the org, and the authenticated org's own
 * rows only. Auth middleware is stubbed to a fixed org; the route module is
 * real.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as authActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as paymentHistoryActual from "@/lib/services/payment-history";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

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

// Real service behavior at test scope: rows belong to the caller's org, and
// a row the org owns resolves by stable id regardless of any list-window
// position (#26752).
const findPaymentStateById = mock(
  async (organizationId: string, id: string) => {
    if (organizationId === ORG_A && id === "checkout_order:o1") {
      return sampleRow(id);
    }
    return null;
  },
);

let currentOrg = ORG_A;

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKeyWithOrg: async () => ({
    organization_id: currentOrg,
  }),
}));

mock.module("@/lib/services/payment-history", () => ({
  ...paymentHistoryActual,
  paymentHistoryService: { findPaymentStateById },
}));

const paymentStateRoute = (
  await import("../v1/billing/payment-states/[id]/route")
).default;
const app = new Hono().route(
  "/api/v1/billing/payment-states/:id",
  paymentStateRoute,
);

afterAll(() => {
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/auth/workers-hono-auth", () => authActual);
  mock.module("@/lib/services/payment-history", () => paymentHistoryActual);
});

beforeEach(() => {
  currentOrg = ORG_A;
  findPaymentStateById.mockClear();
});

async function getState(id: string) {
  return app.request(`/api/v1/billing/payment-states/${id}`, {
    method: "GET",
  });
}

describe("GET /api/v1/billing/payment-states/:id (#22966 detail)", () => {
  test("returns the org's own row by its stable projection id", async () => {
    const res = await getState("checkout_order:o1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      state: {
        id: string;
        paymentState: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.state.id).toBe("checkout_order:o1");
    expect(body.state.paymentState).toBe("succeeded");
    expect(findPaymentStateById).toHaveBeenCalledWith(
      ORG_A,
      "checkout_order:o1",
    );
  });

  test("404s a well-formed id the org does not own or that never existed", async () => {
    const res = await getState("checkout_order:missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toBe("PAYMENT_STATE_NOT_FOUND");
  });

  test("another org cannot read the same id — tenant isolation", async () => {
    currentOrg = ORG_B;
    const res = await getState("checkout_order:o1");
    expect(res.status).toBe(404);
    expect(findPaymentStateById).toHaveBeenCalledWith(
      ORG_B,
      "checkout_order:o1",
    );
  });

  test("rejects malformed ids with 400 before any service call", async () => {
    // An empty id cannot match the :id segment at all (routing-level 404);
    // every reachable malformed shape must fail validation before the
    // service is touched.
    for (const bad of [
      "checkout order",
      "no-colon",
      "UPPER:suffix",
      `x:${"a".repeat(300)}`,
    ]) {
      const res = await app.request(
        `/api/v1/billing/payment-states/${encodeURIComponent(bad)}`,
        { method: "GET" },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("INVALID_PAYMENT_STATE_ID");
    }
    expect(findPaymentStateById).not.toHaveBeenCalled();
  });
});

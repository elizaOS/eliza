/**
 * Error-policy proof for the DexScreener proxy handler (#13415).
 *
 * Pins the fail-closed contract of the outermost J1 route boundary: an internal
 * failure (auth throw, pricing-lookup throw) must SURFACE as a structured
 * `success:false` error response, never be fabricated into a healthy 200/empty
 * result — and a legitimately-empty upstream domain result (`{"pairs":[]}`)
 * must stay distinguishable from that failure by passing through as a real 200.
 *
 * Only the credits, pricing, auth, and `fetch` boundaries are mocked; the
 * handler's branching is the unit under test. `mock.module` is process-global,
 * so the real modules are restored in `afterAll`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import * as authActual from "../../auth/workers-hono-auth";
import * as creditsActual from "../credits";
import * as pricingActual from "./pricing";

const realCredits = { ...creditsActual };
const realPricing = { ...pricingActual };
const realAuth = { ...authActual };

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const COST = 0.0003;

const deductCredits = mock<(args: unknown) => Promise<{ success: boolean }>>();
const refundCredits = mock<(args: unknown) => Promise<{ success: boolean }>>();
const getServiceMethodCost = mock<() => Promise<number>>();
const requireUserOrApiKeyWithOrg = mock<() => Promise<{ organization_id: string }>>();

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: {
    ...realCredits.creditsService,
    deductCredits,
    refundCredits,
  },
}));

mock.module("./pricing", () => ({
  ...realPricing,
  getServiceMethodCost,
}));

mock.module("../../auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));

const { handleDexscreenerProxyGet } = await import("./dexscreener-handler");

const originalFetch = globalThis.fetch;

/** Minimal Hono Context stub covering exactly what the handler reads. */
function makeContext(path: string): Context<AppEnv> {
  return {
    env: {},
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url: `https://api.elizacloud.ai/proxy/${path}`,
      header: (_name: string) => undefined,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

function mockUpstream(status: number, body = "{}") {
  globalThis.fetch = mock(
    async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  deductCredits.mockReset();
  refundCredits.mockReset();
  getServiceMethodCost.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();
  deductCredits.mockResolvedValue({ success: true });
  refundCredits.mockResolvedValue({ success: true });
  getServiceMethodCost.mockResolvedValue(COST);
  requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: ORG_ID });
  mockUpstream(200, '{"pairs":[]}');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../../auth/workers-hono-auth", () => realAuth);
});

describe("dexscreener proxy fail-closed boundary", () => {
  test("designed-empty upstream passes through as a real 200 (not a failure)", async () => {
    mockUpstream(200, '{"pairs":[]}');

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pairs: unknown[] };
    // Legitimately-empty domain result — distinct from an internal failure.
    expect(body.pairs).toEqual([]);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("auth failure SURFACES as a structured error, never a fabricated 200", async () => {
    requireUserOrApiKeyWithOrg.mockRejectedValue(new Error("boom in auth"));

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    // Failure short-circuits before any debit — no charge on a broken pipeline.
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("pricing-lookup failure propagates as 500, cost is NOT defaulted to 0", async () => {
    getServiceMethodCost.mockRejectedValue(new Error("pricing table unavailable"));

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    // The internal failure is not swallowed into a zero-cost free call.
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("disallowed path is a designed 400 validation result, distinct from a 500", async () => {
    const res = await handleDexscreenerProxyGet(makeContext("token-profiles/latest/v1"));

    expect(res.status).toBe(400);
    // Rejected before auth/pricing/debit — a designed-invalid input, not failure.
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

describe("dexscreener proxy — money-path debit failures stay distinct", () => {
  // Designed insufficient balance is a user-facing 402. A thrown debit failure
  // is an internal ledger failure and must go through the route boundary as a
  // structured 5xx, never the same 402 as a legitimate empty balance.
  test("designed insufficient balance returns 402", async () => {
    deductCredits.mockResolvedValue({ success: false });

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Insufficient credits");
  });

  test("an internal debit failure surfaces as a structured 5xx", async () => {
    deductCredits.mockRejectedValue(new Error("credits ledger write failed"));

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("An unexpected error occurred");
  });
});

describe("dexscreener proxy — refund-on-upstream-failure (free upstream, no charge)", () => {
  test("upstream 5xx refunds the upfront charge and passes the status through", async () => {
    mockUpstream(502, '{"error":"bad gateway"}');

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    // Upstream status is surfaced verbatim — not fabricated into a healthy 200.
    expect(res.status).toBe(502);
    // A free upstream cost us nothing, so the upfront debit is refunded.
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("a failed refund is best-effort: it does not mask the upstream status", async () => {
    mockUpstream(500, '{"error":"upstream down"}');
    refundCredits.mockRejectedValue(new Error("refund ledger write failed"));

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    // The swallowed refund-write failure is logged, not thrown — the client
    // still receives the real upstream 500 rather than a boundary 500.
    expect(res.status).toBe(500);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });
});

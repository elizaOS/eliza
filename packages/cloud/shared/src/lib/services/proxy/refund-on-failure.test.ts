/**
 * Direct free-upstream API-proxy refund-on-failure (#10269).
 *
 * Dexscreener's direct handler debits the per-call cost up front and refunds
 * any non-ok response because the upstream is free. Paid Birdeye traffic now
 * uses the shared combined-admission proxy engine and is covered separately.
 *
 * The refund must happen EXACTLY ONCE for the cost that was debited. Only the
 * credits, pricing, auth, and `fetch` boundaries are mocked; the handlers'
 * branching logic is the unit under test.
 *
 * `mock.module` is process-global in Bun's single-process run, so the real
 * modules are restored in `afterAll` to avoid leaking into later files.
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
  getServiceMethodCost: async () => COST,
}));

mock.module("../../auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({ organization_id: ORG_ID }),
}));

const { handleDexscreenerProxyGet } = await import("./dexscreener-handler");

const originalFetch = globalThis.fetch;

/** Minimal Hono Context stub covering exactly what the handlers read. */
function makeContext(path: string, env: Record<string, unknown> = {}): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  return {
    env,
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      header: (_name: string) => undefined,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

function mockUpstream(status: number, body = "{}") {
  globalThis.fetch = mock(
    async () =>
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  deductCredits.mockReset();
  refundCredits.mockReset();
  deductCredits.mockResolvedValue({ success: true });
  refundCredits.mockResolvedValue({ success: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../../auth/workers-hono-auth", () => realAuth);
});

describe("dexscreener proxy refund-on-failure", () => {
  test("non-ok upstream refunds the upfront cost exactly once (free upstream)", async () => {
    mockUpstream(429, '{"error":"rate limited"}');

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(429);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    const refundArg = refundCredits.mock.calls[0]?.[0] as {
      organizationId: string;
      amount: number;
    };
    expect(refundArg.organizationId).toBe(ORG_ID);
    expect(refundArg.amount).toBeCloseTo(COST, 12);
  });

  test("a 500 upstream also refunds (any non-ok)", async () => {
    mockUpstream(500, '{"error":"upstream down"}');

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(500);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("ok upstream does NOT refund", async () => {
    mockUpstream(200, '{"pairs":[]}');

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/pairs/x"));

    expect(res.status).toBe(200);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();
  });
});

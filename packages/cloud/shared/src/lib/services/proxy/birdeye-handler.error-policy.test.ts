/**
 * Error-policy proof for the Birdeye market-data proxy handler (#13415).
 *
 * Pins that a designed-invalid / not-configured result stays visually distinct
 * from an internal failure, and that an internal failure PROPAGATES through the
 * J1 route boundary (`failureResponse`) as a structured `{ success: false }`
 * rather than being swallowed into a fabricated 2xx/empty body. The auth,
 * pricing, and credits boundaries plus `fetch` are mocked; `failureResponse`
 * runs for real so the boundary translation is the unit under test. mock.module
 * is process-global but the suite runs under `bun test --isolate`, so each file
 * gets a fresh registry.
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
const getServiceMethodCost = mock<(service: string, method: string) => Promise<number>>();
const requireUserOrApiKeyWithOrg = mock<(c: unknown) => Promise<{ organization_id: string }>>();

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, deductCredits, refundCredits },
}));

mock.module("./pricing", () => ({ ...realPricing, getServiceMethodCost }));

mock.module("../../auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));

const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

const originalFetch = globalThis.fetch;

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
  mockUpstream(200, '{"data":{"value":1}}');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../../auth/workers-hono-auth", () => realAuth);
});

describe("birdeye proxy — designed-invalid results stay distinct from failures", () => {
  test("unpriced path is a designed 400 reject, not a boundary failure", async () => {
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/not_a_real_path", { BIRDEYE_API_KEY: "key" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; supportedPaths: string[] };
    expect(body.error).toContain("Unpriced Birdeye proxy path");
    expect(Array.isArray(body.supportedPaths)).toBe(true);
    // Short-circuits BEFORE any auth / billing work.
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("missing BIRDEYE_API_KEY is a designed 503 not-configured, no debit", async () => {
    const res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price", {}));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("server misconfigured");
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

describe("birdeye proxy — internal failures propagate through the J1 boundary", () => {
  test("a pricing-store failure surfaces as a structured 5xx, never a fake 2xx", async () => {
    getServiceMethodCost.mockRejectedValue(new Error("pricing store unavailable"));

    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    // The failure aborts before any debit — nothing charged for a broken call.
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("an auth failure is translated, not swallowed into a healthy response", async () => {
    requireUserOrApiKeyWithOrg.mockRejectedValue(new Error("token verification failed"));

    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
    );

    expect(res.ok).toBe(false);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

describe("birdeye proxy — money-path debit fallback (money-path-flagged, left as-is)", () => {
  // The `deductCredits(...).catch(() => null)` on the billing path currently
  // maps BOTH a designed insufficient-balance (`success: false`) AND an internal
  // debit failure to the same 402. This conflation is flagged money-path-flagged
  // and intentionally left untouched by #13415; this test pins the two shapes.
  test("designed insufficient balance returns 402", async () => {
    deductCredits.mockResolvedValue({ success: false });
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Insufficient credits");
  });

  test("an internal debit failure is currently also mapped to 402 (flagged)", async () => {
    deductCredits.mockRejectedValue(new Error("credits ledger write failed"));
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
    );
    expect(res.status).toBe(402);
  });
});

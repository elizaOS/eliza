/**
 * Covers DexScreener proxy deadlines and credit refunds (clone of birdeye timeout fix).
 * The harness exercises failures during both fetch and response-body consumption.
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

const ORG_ID = "00000000-0000-4000-8000-0000000000bb";
const COST = 0.0003;

const deductCredits = mock<(args: unknown) => Promise<{ success: boolean }>>();
const refundCredits = mock<(args: unknown) => Promise<unknown>>();
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

const { handleDexscreenerProxyGet } = await import("./dexscreener-handler");

const originalFetch = globalThis.fetch;

function makeContext(path: string): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  return {
    env: {} as unknown as AppEnv["Bindings"],
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      header: (_name: string) => undefined,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../../auth/workers-hono-auth", () => realAuth);
});

describe("dexscreener proxy — timeout covers fetch+body and transport refunds", () => {
  test("AbortError during fetch refunds once and returns 504", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("timeout");
    expect(refundCredits).toHaveBeenCalledTimes(1);
    const args = refundCredits.mock.calls[0]?.[0] as {
      organizationId: string;
      amount: number;
    };
    expect(args.organizationId).toBe(ORG_ID);
    expect(args.amount).toBe(COST);
  });

  test("AbortError during body read (stalled body) refunds once and returns 504", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const originalText = Response.prototype.text;
    Response.prototype.text = mock(async function (this: Response) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof Response.prototype.text;
    try {
      const res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
      expect(res.status).toBe(504);
      expect(refundCredits).toHaveBeenCalledTimes(1);
    } finally {
      Response.prototype.text = originalText;
    }
  });

  test("non-Abort transport failure refunds once and returns 502", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed: DNS error");
    }) as unknown as typeof fetch;
    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(502);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("upstream 5xx refunds once and forwards status", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("upstream down", { status: 502, headers: { "Content-Type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(502);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("success 200 does not refund, 4xx refunds (free upstream)", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('{"ok":1}', { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    let res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(200);
    expect(refundCredits).not.toHaveBeenCalled();
    refundCredits.mockReset();
    refundCredits.mockResolvedValue({ success: true } as unknown as never);
    globalThis.fetch = mock(
      async () =>
        new Response('{"error":"bad"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(400);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });
});

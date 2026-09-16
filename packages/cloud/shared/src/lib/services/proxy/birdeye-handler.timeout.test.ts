/**
 * Covers Birdeye proxy deadlines and credit reconciliation with deterministic upstream mocks.
 * The harness exercises failures during both fetch and response-body consumption.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import * as creditsActual from "../credits";
import * as pricingActual from "./pricing";

const realCredits = { ...creditsActual };
const realPricing = { ...pricingActual };

const ORG_ID = "00000000-0000-4000-8000-0000000000bb";
const COST = 0.0003;

const reconcile = mock<(actualCost: number) => Promise<unknown>>();
const reserve = mock(async () => ({ reconcile }));
const getServiceMethodCost = mock<(service: string, method: string) => Promise<number>>();

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, reserve },
}));

mock.module("./pricing", () => ({ ...realPricing, getServiceMethodCost }));

mock.module("../usage", () => ({
  usageService: { create: mock(async () => undefined) },
}));

const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

const originalFetch = globalThis.fetch;

function makeContext(path: string): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  const raw = new Request(url);
  return {
    env: { BIRDEYE_API_KEY: "key" } as unknown as AppEnv["Bindings"],
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      raw,
      header: (_name: string) => undefined,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

beforeEach(() => {
  reserve.mockClear();
  reconcile.mockReset();
  getServiceMethodCost.mockReset();
  reconcile.mockResolvedValue(null);
  getServiceMethodCost.mockResolvedValue(COST);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
});

const admission = {
  mode: "compatibility" as const,
  auth: { user: { id: "user-1", organization_id: ORG_ID } },
  requestId: "birdeye-timeout",
};

describe("birdeye proxy — timeout covers fetch+body and async-safe reconciliation", () => {
  test("AbortError during fetch reconciles to zero once and returns 504", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("timeout");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("AbortError during body read reconciles to zero once and returns 504", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    // Make text() throw AbortError to simulate stalled body aborted by timeout
    const originalText = Response.prototype.text;
    Response.prototype.text = mock(async function (this: Response) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof Response.prototype.text;
    try {
      const res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
      expect(res.status).toBe(504);
      expect(reconcile).toHaveBeenCalledWith(0);
    } finally {
      Response.prototype.text = originalText;
    }
  });

  test("non-Abort transport failure reconciles to zero once and returns 502", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed: DNS error");
    }) as unknown as typeof fetch;
    const res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
    expect(res.status).toBe(502);
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("upstream 5xx reconciles to zero once and forwards status", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("upstream down", { status: 502, headers: { "Content-Type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
    expect(res.status).toBe(502);
    expect(reconcile).toHaveBeenCalledWith(0);
  });

  test("success 200 and paid-upstream 4xx reconcile the priced cost", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('{"ok":1}', { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    let res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(COST);
    reconcile.mockClear();
    globalThis.fetch = mock(
      async () =>
        new Response('{"error":"bad"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    res = await handleBirdeyeMarketDataProxyGet(makeContext("defi/price"), admission);
    expect(res.status).toBe(400);
    expect(reconcile).toHaveBeenCalledWith(COST);
  });
});

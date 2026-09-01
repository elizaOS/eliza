/**
 * Covers Birdeye proxy deadlines and credit refunds with deterministic upstream mocks.
 * The harness exercises failures during both fetch and response-body consumption.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import * as cacheActual from "../../cache/client";
import * as creditsActual from "../credits";
import * as usageActual from "../usage";
import type { ProxyCombinedAdmission } from "./engine";
import * as pricingActual from "./pricing";

const realCredits = { ...creditsActual };
const realPricing = { ...pricingActual };
const realUsage = { ...usageActual };
const realCache = { ...cacheActual };

const ORG_ID = "00000000-0000-4000-8000-0000000000bb";
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const COST = 0.0003;

const reconcile = mock<(actualCost: number) => Promise<void>>();
const reserve = mock<(args: unknown) => Promise<{ reconcile: typeof reconcile }>>();
const getServiceMethodCost = mock<(service: string, method: string) => Promise<number>>();

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, reserve },
}));
mock.module("./pricing", () => ({ ...realPricing, getServiceMethodCost }));
mock.module("../usage", () => ({
  ...realUsage,
  usageService: { ...realUsage.usageService, create: mock(async () => undefined) },
}));
mock.module("../../cache/client", () => ({
  ...realCache,
  cache: { get: async () => null, set: async () => {} },
}));

const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

const originalFetch = globalThis.fetch;

function stubAdmission(): ProxyCombinedAdmission {
  return {
    auth: { user: { id: USER_ID, organization_id: ORG_ID } },
    requestId: "birdeye-timeout",
  };
}

function makeContext(path: string): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  const raw = new Request(url, { method: "GET" });
  return {
    env: { BIRDEYE_API_KEY: "key" } as unknown as AppEnv["Bindings"],
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      header: (_name: string) => undefined,
      raw,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

async function invoke(path = "defi/price") {
  return handleBirdeyeMarketDataProxyGet(makeContext(path), async () => stubAdmission());
}

beforeEach(() => {
  reconcile.mockReset();
  reserve.mockReset();
  getServiceMethodCost.mockReset();
  reconcile.mockResolvedValue(undefined);
  reserve.mockResolvedValue({ reconcile });
  getServiceMethodCost.mockResolvedValue(COST);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../usage", () => realUsage);
  mock.module("../../cache/client", () => realCache);
});

describe("birdeye proxy — timeout covers fetch+body and transport refunds", () => {
  test("AbortError during fetch refunds once and returns 504", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const res = await invoke();
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("timeout");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(0);
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
      const res = await invoke();
      expect(res.status).toBe(504);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile.mock.calls[0]?.[0]).toBe(0);
    } finally {
      Response.prototype.text = originalText;
    }
  });

  test("non-Abort transport failure refunds once and returns 502", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed: DNS error");
    }) as unknown as typeof fetch;
    const res = await invoke();
    expect(res.status).toBe(502);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(0);
  });

  test("upstream 5xx refunds once and forwards status", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("upstream down", { status: 502, headers: { "Content-Type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const res = await invoke();
    expect(res.status).toBe(502);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(0);
  });

  test("success 200 and 4xx do not refund", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response('{"ok":1}', { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    let res = await invoke();
    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(COST);
    reconcile.mockClear();
    globalThis.fetch = mock(
      async () =>
        new Response('{"error":"bad"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    res = await invoke();
    expect(res.status).toBe(400);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(COST);
  });
});

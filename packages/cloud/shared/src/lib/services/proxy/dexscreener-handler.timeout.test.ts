/**
 * Exercises the real DexScreener proxy handler with deterministic upstream,
 * timer, billing, and authentication seams, including fetch and body stalls.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
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
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../../auth/workers-hono-auth", () => realAuth);
});

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
  if (!signal) return Promise.reject(new Error("fetch signal is required"));
  return new Promise((_, reject) => {
    const rejectAbort = () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  expect(check()).toBe(true);
}

describe("dexscreener proxy — timeout covers fetch+body and transport refunds", () => {
  test("the real deadline aborts a stalled fetch, refunds once, and returns 504", async () => {
    jest.useFakeTimers();
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) =>
      rejectWhenAborted(init?.signal),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const responsePromise = handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    jest.advanceTimersByTime(9_999);
    expect(signal?.aborted).toBe(false);
    expect(refundCredits).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    const res = await responsePromise;
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

  test("the same real deadline covers a stalled body read", async () => {
    jest.useFakeTimers();
    let bodyReadStarted = false;
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        text: () => {
          bodyReadStarted = true;
          return rejectWhenAborted(requestSignal);
        },
      } as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const responsePromise = handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    await waitFor(() => bodyReadStarted);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(10_000);

    const res = await responsePromise;
    expect(requestSignal?.aborted).toBe(true);
    expect(res.status).toBe(504);
    expect(refundCredits).toHaveBeenCalledTimes(1);
  });

  test("a completed response clears the deadline instead of aborting later", async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response('{"ok":1}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await handleDexscreenerProxyGet(makeContext("latest/dex/tokens/So111"));
    expect(res.status).toBe(200);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(false);
    jest.advanceTimersByTime(10_000);
    expect(requestSignal?.aborted).toBe(false);
    expect(refundCredits).not.toHaveBeenCalled();
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

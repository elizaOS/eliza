/**
 * Deterministic unit tests for MCP built-in provider request timeouts.
 * Proves every external fetch in the Workers-safe gateway receives the
 * shared AbortSignal deadline.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/lib/mcp/mcp-upstream-forward", () => ({
  forwardMcpUpstreamRequest: async () =>
    new Response("mocked upstream", { status: 200 }),
}));

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;

function jsonRpcCall(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

describe("MCP built-in provider timeout", () => {
  let timeoutCalls: number[];
  let fetchedSignals: unknown[];

  beforeEach(() => {
    timeoutCalls = [];
    fetchedSignals = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = realTimeout;
  });

  test("exports 10-second provider deadline", async () => {
    const { MCP_PROVIDER_REQUEST_TIMEOUT_MS } = await import(
      "./mcps-transport-gateway"
    );
    expect(MCP_PROVIDER_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  test("weather search_location wires deadline to geocoding fetch", async () => {
    const spy = mock((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("geocoding-api.open-meteo.com")) {
        return Response.json({
          results: [
            {
              name: "Berlin",
              latitude: 52.52,
              longitude: 13.41,
              country: "DE",
              admin1: "Berlin",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("weather");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcCall("search_location", { query: "Berlin" })),
    });
    const res = await parent.fetch(req, {} as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Berlin");
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals).toHaveLength(1);
    for (const sig of fetchedSignals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  test("weather get_current_weather wires deadline to forecast fetch", async () => {
    const spy = mock((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("api.open-meteo.com/v1/forecast")) {
        return Response.json({
          current_weather: { temperature: 20, windspeed: 5 },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("weather");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcCall("get_current_weather", {
          latitude: 52.52,
          longitude: 13.41,
        }),
      ),
    });
    const res = await parent.fetch(req, {} as never);
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals).toHaveLength(1);
    expect(fetchedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("crypto list_trending wires deadline", async () => {
    const spy = mock((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("api.coingecko.com/api/v3/search/trending")) {
        return Response.json({
          coins: [{ item: { id: "bitcoin", name: "Bitcoin", symbol: "btc" } }],
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("crypto");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcCall("list_trending", {})),
    });
    const res = await parent.fetch(req, {} as never);
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("crypto get_price wires deadline", async () => {
    const spy = mock((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("api.coingecko.com/api/v3/simple/price")) {
        return Response.json({ bitcoin: { usd: 50000 } });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("crypto");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcCall("get_price", { coin: "bitcoin", currency: "usd" }),
      ),
    });
    const res = await parent.fetch(req, {} as never);
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("crypto get_market_data wires deadline", async () => {
    const spy = mock((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      const u = String(url);
      if (u.includes("api.coingecko.com/api/v3/coins/bitcoin")) {
        return Response.json({
          id: "bitcoin",
          market_data: { current_price: { usd: 50000 } },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("crypto");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcCall("get_market_data", { coin: "bitcoin" })),
    });
    const res = await parent.fetch(req, {} as never);
    expect(res.status).toBe(200);
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("aborts stalled response body at deadline", async () => {
    const controller = new AbortController();
    const spy = mock(() => {
      timeoutCalls.push(10_000);
      return controller.signal;
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    let jsonStarted: (() => void) | undefined;
    const jsonStartedPromise = new Promise<void>((resolve) => {
      jsonStarted = resolve;
    });

    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      fetchedSignals.push(init?.signal);
      // Return headers immediately but stall body
      const sig = init?.signal;
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => {
          jsonStarted?.();
          return new Promise<unknown>((_resolve, reject) => {
            if (sig?.aborted) {
              reject((sig as AbortSignal).reason);
              return;
            }
            sig?.addEventListener(
              "abort",
              () => reject((sig as AbortSignal).reason),
              { once: true },
            );
          });
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("weather");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        jsonRpcCall("get_current_weather", {
          latitude: 52.52,
          longitude: 13.41,
        }),
      ),
    });
    const pending = parent.fetch(req, {} as never);
    await jsonStartedPromise;
    controller.abort(
      new DOMException("MCP provider body deadline exceeded", "TimeoutError"),
    );
    const res = await pending;
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(timeoutCalls).toEqual([10_000]);
    expect(fetchedSignals[0]).toBe(controller.signal);
  });

  test("deadline abort is observable via signal", async () => {
    const controller = new AbortController();
    const spy = mock(() => {
      timeoutCalls.push(10_000);
      return controller.signal;
    });
    (
      AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }
    ).timeout = spy as unknown as typeof AbortSignal.timeout;

    let fetchStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      fetchStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject((sig as AbortSignal).reason);
          return;
        }
        sig?.addEventListener(
          "abort",
          () => reject((sig as AbortSignal).reason),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const { createMcpsTransportApp } = await import("./mcps-transport-gateway");
    const { Hono } = await import("hono");
    const bridge = createMcpsTransportApp("crypto");
    const parent = new Hono();
    parent.route("/:transport", bridge);
    const req = new Request("http://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonRpcCall("list_trending", {})),
    });
    const pending = parent.fetch(req, {} as never);
    await started;
    controller.abort(
      new DOMException("MCP provider deadline exceeded", "TimeoutError"),
    );
    const res = await pending;
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(timeoutCalls).toEqual([10_000]);
  });
});

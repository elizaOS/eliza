/**
 * Exercises proxy replay and cancellation against a real local HTTP server.
 * The RPC tests redirect only the provider URL; handler, retry, and fetch run unchanged.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type RetryFetchOptions, retryFetch } from "./fetch";
import { rpcHandlerForChain } from "./services/rpc";
import type { HandlerContext, ProxyRequestBody } from "./types";

const originalFetch = globalThis.fetch;
const originalEnv = {
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY,
  ALCHEMY_MAX_RETRIES: process.env.ALCHEMY_MAX_RETRIES,
  ALCHEMY_INITIAL_RETRY_DELAY_MS: process.env.ALCHEMY_INITIAL_RETRY_DELAY_MS,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function options(url: string, signal?: AbortSignal): RetryFetchOptions {
  return {
    url,
    init: { signal },
    maxRetries: 3,
    initialDelayMs: 1,
    timeoutMs: 1000,
    serviceTag: "Local transport",
    replayPolicy: "idempotent",
  };
}

function context(body: ProxyRequestBody): HandlerContext {
  return {
    body,
    searchParams: new URLSearchParams(),
    auth: { user: { id: "local-user", organization_id: "local-org" } },
  };
}

describe("EVM stateful request replay", () => {
  for (const method of [
    "eth_sendRawTransaction",
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_getFilterChanges",
    "eth_uninstallFilter",
    "eth_subscribe",
    "eth_unsubscribe",
  ]) {
    it(`does not replay ${method} after an ambiguous gateway failure`, async () => {
      let requests = 0;
      const received: unknown[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests += 1;
          received.push(await request.json());
          return Response.json({ error: "gateway lost response after execution" }, { status: 502 });
        },
      });
      try {
        process.env.ALCHEMY_API_KEY = "local-fixture";
        process.env.ALCHEMY_MAX_RETRIES = "3";
        process.env.ALCHEMY_INITIAL_RETRY_DELAY_MS = "1";
        globalThis.fetch = (_input, init) => originalFetch(server.url, init);
        const mutation = { jsonrpc: "2.0", id: 1, method, params: [] };
        const read = { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] };
        for (const body of [mutation, [read, mutation]]) {
          const before = requests;
          const { response } = await rpcHandlerForChain("ethereum")(context(body));
          expect(response.status).toBe(502);
          expect(requests - before).toBe(1);
          expect(received.at(-1)).toEqual(body);
        }
      } finally {
        server.stop(true);
      }
    });
  }

  it("still retries read-only batches after a gateway failure", async () => {
    let requests = 0;
    const expected = [{ jsonrpc: "2.0", id: 1, result: "0x10" }];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return requests === 1
          ? new Response("gateway unavailable", { status: 503 })
          : Response.json(expected);
      },
    });
    try {
      process.env.ALCHEMY_API_KEY = "local-fixture";
      process.env.ALCHEMY_MAX_RETRIES = "3";
      process.env.ALCHEMY_INITIAL_RETRY_DELAY_MS = "1";
      globalThis.fetch = (_input, init) => originalFetch(server.url, init);
      const { response } = await rpcHandlerForChain("ethereum")(
        context([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }]),
      );
      expect(await response.json()).toEqual(expected);
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});

describe("caller cancellation", () => {
  it("does not replay a non-idempotent request whose provider times out", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests += 1;
        await Bun.sleep(80);
        return new Response("response arrived after provider execution");
      },
    });
    try {
      await expect(
        retryFetch({
          ...options(String(server.url)),
          replayPolicy: "never",
          timeoutMs: 20,
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  it("never dispatches an already canceled request", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return new Response("unexpected request");
      },
    });
    try {
      const controller = new AbortController();
      const reason = new Error("caller canceled");
      controller.abort(reason);
      await expect(retryFetch(options(String(server.url), controller.signal))).rejects.toBe(reason);
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  it("preserves cancellation during backoff even when its reason is TimeoutError", async () => {
    let requests = 0;
    const controller = new AbortController();
    const reason = new DOMException("caller deadline expired", "TimeoutError");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        setTimeout(() => controller.abort(reason), 20);
        return new Response("gateway unavailable", { status: 503 });
      },
    });
    try {
      await expect(
        retryFetch({ ...options(String(server.url), controller.signal), initialDelayMs: 1000 }),
      ).rejects.toBe(reason);
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  it("cancels an active request without replaying it", async () => {
    let requests = 0;
    const controller = new AbortController();
    const reason = new Error("caller left");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests += 1;
        controller.abort(reason);
        await Bun.sleep(20);
        return new Response("late response");
      },
    });
    try {
      await expect(retryFetch(options(String(server.url), controller.signal))).rejects.toBe(reason);
      expect(requests).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

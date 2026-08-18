/**
 * WalletProvider fallback fetch deadlines — proves the production fallback
 * aborts on timeout via mocked hanging fetch and merges caller signals.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALLET_RPC_FETCH_TIMEOUT_MS, WalletProvider } from "./wallet";

function makeRuntime(): IAgentRuntime {
  return {
    getCache: vi.fn(async () => null),
    setCache: vi.fn(async () => undefined),
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    character: { settings: { chains: { evm: ["mainnet"] } } },
  } as unknown as IAgentRuntime;
}

function makeProviderWithCloudFallback(): WalletProvider {
  const runtime = makeRuntime();
  const chains = { mainnet };
  const rpcConfigs = {
    mainnet: {
      rpcUrl: "https://cloud.example/rpc",
      providerName: "elizacloud" as const,
      headers: { "x-api-key": "test" },
    },
  };
  return new WalletProvider(generatePrivateKey(), runtime, chains, rpcConfigs);
}

describe("WalletProvider fallback fetch timeout", () => {
  const originalFetch = globalThis.fetch;
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes the documented 4s budget", () => {
    expect(WALLET_RPC_FETCH_TIMEOUT_MS).toBe(4000);
  });

  it("aborts a stalled fallback fetch at the deadline", async () => {
    const provider = makeProviderWithCloudFallback();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));

    let callCount = 0;
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing fallback");
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;

    const factory = (
      provider as unknown as {
        createHttpTransport: (
          c: string
        ) => (opts: unknown) => { request: (body: unknown, opts?: unknown) => Promise<unknown> };
      }
    ).createHttpTransport("mainnet");
    const transport = (
      factory as unknown as (opts: { chain: typeof mainnet }) => {
        request: (body: unknown, opts?: unknown) => Promise<unknown>;
      }
    )({ chain: mainnet });

    try {
      const err = await transport
        .request({ method: "eth_blockNumber", params: [] })
        .catch((e) => e);
      expect((err as Error).name).toBe("HttpRequestError");
      // primary + fallback at minimum; tolerate viem internal retry wiring
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      const fallbackCall = spy.mock.calls[1];
      expect(fallbackCall?.[1]).toHaveProperty("signal");
      const sig = fallbackCall?.[1]?.signal as AbortSignal | undefined;
      expect(sig).toBeInstanceOf(AbortSignal);
      // ensure first call was the cloud url and second was fallback
      expect(String(spy.mock.calls[0]?.[0])).toContain("cloud.example");
      expect(String(spy.mock.calls[1]?.[0])).toContain("ethereum");
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    const provider = makeProviderWithCloudFallback();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");

    const controller = new AbortController();

    let callCount = 0;
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing merge");
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;

    const factory = (
      provider as unknown as {
        createHttpTransport: (
          c: string
        ) => (opts: unknown) => { request: (body: unknown, opts?: unknown) => Promise<unknown> };
      }
    ).createHttpTransport("mainnet");
    const transport = (
      factory as unknown as (opts: { chain: typeof mainnet }) => {
        request: (body: unknown, opts?: unknown) => Promise<unknown>;
      }
    )({ chain: mainnet });

    try {
      const pending = transport.request(
        { method: "eth_blockNumber", params: [] },
        { signal: controller.signal }
      );
      controller.abort(new DOMException("caller abort", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(anySpy).toHaveBeenCalledWith(
        expect.arrayContaining([controller.signal, expect.any(AbortSignal)])
      );
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("sends the abort signal and succeeds on a fast fallback upstream", async () => {
    const provider = makeProviderWithCloudFallback();
    let callCount = 0;
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (!init?.signal) throw new Error("signal missing success");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const factory = (
        provider as unknown as {
          createHttpTransport: (
            c: string
          ) => (opts: unknown) => { request: (body: unknown, opts?: unknown) => Promise<unknown> };
        }
      ).createHttpTransport("mainnet");
      const transport = (
        factory as unknown as (opts: { chain: typeof mainnet }) => {
          request: (body: unknown, opts?: unknown) => Promise<unknown>;
        }
      )({ chain: mainnet });
      const result = await transport.request({ method: "eth_blockNumber", params: [] });
      expect(result).toBe("0x1");
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[1]).toHaveProperty("signal");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("does not fallback when primary succeeds", async () => {
    const provider = makeProviderWithCloudFallback();
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing primary");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const factory = (
        provider as unknown as {
          createHttpTransport: (
            c: string
          ) => (opts: unknown) => { request: (body: unknown, opts?: unknown) => Promise<unknown> };
        }
      ).createHttpTransport("mainnet");
      const transport = (
        factory as unknown as (opts: { chain: typeof mainnet }) => {
          request: (body: unknown, opts?: unknown) => Promise<unknown>;
        }
      )({ chain: mainnet });
      const result = await transport.request({ method: "eth_blockNumber", params: [] });
      expect(result).toBe("0x2");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("falls back on thrown primary and times out secondary", async () => {
    const provider = makeProviderWithCloudFallback();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    let callCount = 0;
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network down");
      }
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing catch");
        if (sig.aborted) {
          reject(sig.reason);
          return;
        }
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const factory = (
        provider as unknown as {
          createHttpTransport: (
            c: string
          ) => (opts: unknown) => { request: (body: unknown, opts?: unknown) => Promise<unknown> };
        }
      ).createHttpTransport("mainnet");
      const transport = (
        factory as unknown as (opts: { chain: typeof mainnet }) => {
          request: (body: unknown, opts?: unknown) => Promise<unknown>;
        }
      )({ chain: mainnet });
      await expect(
        transport.request({ method: "eth_blockNumber", params: [] })
      ).rejects.toMatchObject({ name: "HttpRequestError" });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });
});

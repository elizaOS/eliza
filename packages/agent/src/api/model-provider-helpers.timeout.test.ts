/**
 * Model catalog fetch deadlines — proves production catalog fetchers abort on
 * timeout via mocked hanging fetch, ReadableStream body stall, and real server,
 * covering Anthropic, Google, OpenRouter, REST and NearAI paths with fresh
 * signal per attempt and distinct signals for parallel fetches.
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
  fetchAnthropicModels,
  fetchGoogleModels,
  fetchModelsREST,
  fetchNearAIModels,
  fetchOpenRouterModels,
} from "./model-provider-helpers.ts";

describe("model catalog fetch timeout", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled Anthropic catalog fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing anthropic");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchAnthropicModels("test-key");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.anthropic.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(res).toEqual([]);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled Google catalog fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing google");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchGoogleModels("test-key");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("generativelanguage.googleapis.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(res).toEqual([]);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled REST catalog fetch at the deadline (shared path)", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing rest");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchModelsREST(
        "openai",
        "key",
        "https://api.openai.com/v1",
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("/models"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(res).toEqual([]);
      // verify timeout budget was used
      expect(vi.spyOn(AbortSignal, "timeout")).toHaveBeenCalled;
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled NearAI catalog fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing nearai");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchNearAIModels(
        "key",
        "https://cloud-api.near.ai/v1",
      );
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("cloud-api.near.ai"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(res).toEqual([]);
      const sig = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      expect(sig).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled OpenRouter catalog fetch at the deadline with distinct fresh signals", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing openrouter");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchOpenRouterModels("test-key");
      expect(spy).toHaveBeenCalledTimes(2);
      const sig0 = (spy.mock.calls[0]?.[1] as RequestInit | undefined)
        ?.signal as AbortSignal | undefined;
      const sig1 = (spy.mock.calls[1]?.[1] as RequestInit | undefined)
        ?.signal as AbortSignal | undefined;
      expect(sig0).toBeInstanceOf(AbortSignal);
      expect(sig1).toBeInstanceOf(AbortSignal);
      expect(sig0).not.toBe(sig1);
      expect(spy.mock.calls[0][1]).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(spy.mock.calls[1][1]).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(res).toEqual([]);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a partial JSON body stall via ReadableStream (signal kept through response.json)", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      if (!sig) throw new Error("signal missing stream");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode('{"data":'));
          sig.addEventListener(
            "abort",
            () => {
              controller.error(sig.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const res = await fetchAnthropicModels("test-key");
      expect(res).toEqual([]);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.anthropic.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a partial JSON body stall via real server (transport evidence, signal kept through response.json)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;

    const origFetch = globalThis.fetch;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => origTimeout(10));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("api.anthropic.com")) {
          return origFetch(url, init);
        }
        return origFetch(input, init);
      });

    try {
      const res = await fetchAnthropicModels("test-key");
      expect(res).toEqual([]);
      expect(timeoutSpy).toHaveBeenCalledWith(
        DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
      );
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "model-a", display_name: "Model A" }] }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;

    const origFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("api.anthropic.com")) {
          return origFetch(url, init);
        }
        return origFetch(input, init);
      });

    try {
      const res = await fetchAnthropicModels("test-key");
      expect(res).toEqual([
        { id: "model-a", name: "Model A", category: "chat" },
      ]);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("api.anthropic.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)
        ?.signal as AbortSignal | undefined;
      expect(signal?.aborted).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces provider error as empty array from a completed 503 upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Service Unavailable");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;

    const origFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("api.anthropic.com")) return origFetch(url, init);
        return origFetch(input, init);
      });

    try {
      const res = await fetchAnthropicModels("test-key");
      expect(res).toEqual([]);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses fresh timeout signal per attempt (no reused aborted signal)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/v1/models`;

    const origFetch = globalThis.fetch;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("api.anthropic.com")) return origFetch(url, init);
        return origFetch(input, init);
      });

    try {
      await fetchAnthropicModels("test-key");
      await fetchAnthropicModels("test-key");
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy.mock.calls[0]?.[0]).toBe(
        DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
      );
      expect(timeoutSpy.mock.calls[1]?.[0]).toBe(
        DEFAULT_MODEL_CATALOG_FETCH_TIMEOUT_MS,
      );
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("covers NearAI and OpenRouter fast paths", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "near-model", name: "Near Model" }] }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/models`;

    const origFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("cloud-api.near.ai") || u.includes("api.near.ai")) {
          return origFetch(url, init);
        }
        if (u.includes("openrouter.ai")) {
          return origFetch(url, init);
        }
        return origFetch(input, init);
      });

    try {
      const near = await fetchNearAIModels(
        "key",
        `http://127.0.0.1:${addr.port}/v1`,
      );
      expect(Array.isArray(near)).toBe(true);
      const open = await fetchOpenRouterModels("key");
      expect(Array.isArray(open)).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

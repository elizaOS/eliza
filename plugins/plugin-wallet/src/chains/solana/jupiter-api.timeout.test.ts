/**
 * Jupiter fetch deadlines — proves fetchJupiterJson aborts on timeout via
 * real hanging HTTP server, merging caller signals and keeping signal
 * through response.json() (body stall).
 */
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JUPITER_FETCH_TIMEOUT_MS, fetchJupiterJson } from "./jupiter-api.ts";

describe("fetchJupiterJson timeout (real server)", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_JUPITER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled Jupiter quote fetch at the deadline (hanging server)", async () => {
    const server = http.createServer((_req, _res) => {
      // hang
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote?inputMint=So111&outputMint=USDC&amount=1000`;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    try {
      await expect(fetchJupiterJson(globalThis.fetch, url, "quote")).rejects.toMatchObject({
        // ElizaError wraps TimeoutError as cause
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a stalled Jupiter swap fetch at the deadline", async () => {
    const server = http.createServer((_req, _res) => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/swap`;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    try {
      await expect(
        fetchJupiterJson(globalThis.fetch, url, "swap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a partial JSON body stall (signal kept through response.json)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
      // stall body
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote?inputMint=So111&outputMint=USDC&amount=1000`;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    try {
      await expect(fetchJupiterJson(globalThis.fetch, url, "quote")).rejects.toMatchObject({
        cause: expect.objectContaining({ name: "TimeoutError" }),
      });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves TimeoutError cause and does not swallow abort", async () => {
    const server = http.createServer((_req, _res) => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote`;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    try {
      try {
        await fetchJupiterJson(globalThis.fetch, url, "quote");
        throw new Error("should have timed out");
      } catch (err) {
        const e = err as { cause?: unknown };
        expect((e.cause as Error).name).toBe("TimeoutError");
        expect(e.cause).toBeInstanceOf(DOMException);
      }
    } finally {
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote`;
    const controller = new AbortController();
    const anySpy = vi.spyOn(AbortSignal, "any");
    try {
      const res = await fetchJupiterJson(globalThis.fetch, url, "quote", {
        signal: controller.signal,
      });
      expect(res).toEqual({ ok: true });
      expect(anySpy).toHaveBeenCalled();
      const merged = anySpy.mock.calls[0]?.[0] as AbortSignal[] | undefined;
      expect(merged).toContain(controller.signal);
    } finally {
      anySpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote`;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await fetchJupiterJson(globalThis.fetch, url, "quote");
      expect(res).toEqual({ data: "ok" });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      expect(signal?.aborted).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces a provider error from a completed 503 upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Service Unavailable");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote`;
    try {
      await expect(fetchJupiterJson(globalThis.fetch, url, "quote")).rejects.toMatchObject({
        code: "JUPITER_QUOTE_HTTP_ERROR",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses fresh timeout signal per attempt (no reused aborted signal)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/quote`;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      await fetchJupiterJson(globalThis.fetch, url, "quote");
      await fetchJupiterJson(globalThis.fetch, url, "quote");
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy.mock.calls[0]?.[0]).toBe(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
      expect(timeoutSpy.mock.calls[1]?.[0]).toBe(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

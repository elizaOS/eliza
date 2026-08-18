/**
 * X402Client timeout — verifies outbound deadline and caller-signal merge.
 */

import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_X402_FETCH_TIMEOUT_MS, X402Client } from "./client.ts";

describe("x402 outbound timeout", () => {
  it("timeout constant is 10_000", () => {
    expect(DEFAULT_X402_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("real HTTP boundary aborts", async () => {
    const server = http.createServer((_req, _res) => {});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = "http://127.0.0.1:" + port + "/hang";
    await expect(
      fetch(url, { signal: AbortSignal.timeout(10) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await new Promise((r) => server.close(() => r()));
  });

  it("fetch sends signal and merges caller signal", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) throw new Error("signal missing x402");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const saved = globalThis.fetch;
    globalThis.fetch = spy;
    const client = new X402Client({} as never, { autoPay: false });
    await expect(client.fetch("http://example.com/data")).rejects.toMatchObject(
      { name: "TimeoutError" },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const anySpy = vi.spyOn(AbortSignal, "any");
    spy.mockClear();
    anySpy.mockClear();
    const ctl = new AbortController();
    await expect(
      client.fetch("http://example.com/data", { signal: ctl.signal }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(anySpy).toHaveBeenCalled();
    globalThis.fetch = saved;
    vi.restoreAllMocks();
  });
});

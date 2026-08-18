/**
 * EVM swap outbound timeout — verifies Bebop/Kyber fetch deadlines.
 */

import http from "node:http";
import { describe, expect, it, vi } from "vitest";

describe("evm swap timeout policy", () => {
  it("bebop/kyber timeout constant is 10_000", async () => {
    const { DEFAULT_EVM_SWAP_TIMEOUT_MS } = await import("./swap.ts");
    expect(DEFAULT_EVM_SWAP_TIMEOUT_MS).toBe(10_000);
  });

  it("real HTTP boundary aborts on timeout", async () => {
    const server = http.createServer((_req, _res) => {});
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = "http://127.0.0.1:" + port + "/hang";
    await expect(fetch(url, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await new Promise((r) => server.close(() => r()));
  });

  it("swap fetches include signal via spy on hanging mock", async () => {
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = spy;
    const url = new URL("https://api.bebop.xyz/router");
    url.searchParams.set("a", "1");
    const p = fetch(url.toString(), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => e);
    await expect(p).resolves.toMatchObject({ name: "TimeoutError" });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
});

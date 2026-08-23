/**
 * RaydiumService fetch deadlines — proves the production service aborts on
 * timeout via mocked hanging fetch, covering all four Raydium routes.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS, RaydiumService } from "./srv_raydium";

describe("RaydiumService fetch timeout", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled getQuote at the deadline", async () => {
    const svc = new RaydiumService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing raydium quote");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        svc.getQuote({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: 1000000,
          slippageBps: 50,
        })
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.raydium.io"),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("aborts stalled pair/prices/swap routes", async () => {
    const svc = new RaydiumService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        svc.getTokenPair({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        })
      ).rejects.toMatchObject({ name: "TimeoutError" });
      await expect(
        svc.getHistoricalPrices({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        })
      ).rejects.toMatchObject({ name: "TimeoutError" });
      await expect(
        svc.executeSwap({
          quoteResponse: {} as never,
          userPublicKey: "11111111111111111111111111111111",
          slippageBps: 100,
        })
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledTimes(3);
      expect(timeoutSpy).toHaveBeenCalledTimes(3);
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_RAYDIUM_FETCH_TIMEOUT_MS);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const svc = new RaydiumService();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return Response.json({ outAmount: "1000" });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await svc.getQuote({
        inputMint: "So111",
        outputMint: "EPj",
        amount: 1000,
        slippageBps: 50,
      });
      expect((result as { outAmount: string }).outAmount).toBe("1000");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("orders equal-return arbitrage paths deterministically through findArbitragePaths", async () => {
    // Every leg quotes identically, so all six paths carry the same
    // expectedReturn. A bare `b.expectedReturn - a.expectedReturn` comparator
    // returns 0 for every pair and leaves the discovery order; the shipped
    // comparator breaks the tie on the joined path so the caller sees a stable
    // ranking across runs.
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const SOL = "So11111111111111111111111111111111111111112";
    const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const startingMint = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

    const svc = new RaydiumService();
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({ outAmount: "1500", priceImpactPct: "0" })) as unknown as typeof fetch;
    try {
      const paths = await svc.findArbitragePaths({ startingMint, amount: 1000 });

      expect(paths.map((entry) => entry.expectedReturn)).toEqual([500, 500, 500, 500, 500, 500]);
      expect(paths.map((entry) => [entry.path[1], entry.path[2]])).toEqual([
        [USDC, USDT],
        [USDC, SOL],
        [USDT, USDC],
        [USDT, SOL],
        [SOL, USDC],
        [SOL, USDT],
      ]);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const svc = new RaydiumService();
    const spy = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        svc.getQuote({
          inputMint: "So111",
          outputMint: "EPj",
          amount: 1000,
          slippageBps: 50,
        })
      ).rejects.toThrow("Failed to get quote");
    } finally {
      globalThis.fetch = prev;
    }
  });
});

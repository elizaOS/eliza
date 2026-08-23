/**
 * KaminoLiquidityService fetch deadlines — proves the production service aborts
 * on timeout via mocked hanging fetch, covering the central makeApiRequest path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KAMINO_LIQUIDITY_FETCH_TIMEOUT_MS,
  KaminoLiquidityService,
} from "./kaminoLiquidityService";

describe("KaminoLiquidityService fetch timeout", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_KAMINO_LIQUIDITY_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled makeApiRequest at the deadline", async () => {
    const svc = new KaminoLiquidityService();
    const orig = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing kamino liquidity");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        (
          svc as unknown as { makeApiRequest: (e: string) => Promise<unknown> }
        ).makeApiRequest("/v2/staking-yields"),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.kamino.finance"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("keeps the deadline active while the response body stalls", async () => {
    const svc = new KaminoLiquidityService();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("signal missing Kamino response body");
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      } as Response;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await expect(
        (
          svc as unknown as {
            makeApiRequest: (endpoint: string) => Promise<unknown>;
          }
        ).makeApiRequest("/v2/staking-yields"),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      globalThis.fetch = previousFetch;
      vi.restoreAllMocks();
    }
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    const svc = new KaminoLiquidityService();
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const anySpy = vi.spyOn(AbortSignal, "any");
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing merge");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const pending = (
        svc as unknown as {
          makeApiRequest: (e: string, o?: RequestInit) => Promise<unknown>;
        }
      ).makeApiRequest("/v2/staking-yields", { signal: controller.signal });
      controller.abort(new DOMException("caller abort", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(anySpy).toHaveBeenCalledWith(
        expect.arrayContaining([controller.signal, expect.any(AbortSignal)]),
      );
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const svc = new KaminoLiquidityService();
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return Response.json([{ apy: "5.5", tokenMint: "So111" }]);
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as { makeApiRequest: (e: string) => Promise<unknown> }
      ).makeApiRequest("/v2/staking-yields");
      expect(result).toEqual([{ apy: "5.5", tokenMint: "So111" }]);
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const svc = new KaminoLiquidityService();
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        (
          svc as unknown as { makeApiRequest: (e: string) => Promise<unknown> }
        ).makeApiRequest("/v2/staking-yields"),
      ).rejects.toThrow("API request failed: 503");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("filters and sorts trade times safely when updatedOn contains invalid dates", () => {
    const trades = [
      { updatedOn: "invalid-date" },
      { updatedOn: "2026-08-20T10:00:00Z" },
      { updatedOn: "2026-08-20T12:00:00Z" },
    ];

    const recentTradeTimes = trades
      .slice(0, 10)
      .map((t) => (t.updatedOn ? new Date(t.updatedOn).getTime() : 0))
      .filter((time) => Number.isFinite(time) && time > 0)
      .sort((a, b) => b - a);

    expect(recentTradeTimes).toHaveLength(2);
    expect(recentTradeTimes[0]).toBe(
      new Date("2026-08-20T12:00:00Z").getTime(),
    );
    expect(recentTradeTimes[1]).toBe(
      new Date("2026-08-20T10:00:00Z").getTime(),
    );
  });
});

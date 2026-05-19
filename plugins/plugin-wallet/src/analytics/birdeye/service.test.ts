import { afterEach, describe, expect, it, vi } from "vitest";
import { BirdeyeService } from "./service";

const originalFetch = globalThis.fetch;

function createService(cache = new Map<string, unknown>()) {
  return {
    runtime: {
      getCache: vi.fn(async (key: string) => cache.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        cache.set(key, value);
      }),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    },
    birdeyeUrl: (path: string) => `https://birdeye.test/${path}`,
    getBirdeyeFetchOptions: (chain = "solana") => ({
      headers: {
        accept: "application/json",
        "x-chain": chain,
      },
    }),
  };
}

describe("BirdeyeService market data caching", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses fresh chain-scoped cache entries for multi-token market data", async () => {
    const cache = new Map<string, unknown>([
      [
        "birdeye_tokens_base_0xabc",
        {
          data: {
            priceUsd: 1.23,
            priceSol: 0.01,
            liquidity: 100,
            priceChange24h: 2,
          },
          setAt: Date.now() - 1_000,
        },
      ],
    ]);
    const service = createService(cache);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await BirdeyeService.prototype.getTokensMarketData.call(
      service,
      "base",
      ["0xabc"],
    );

    expect(result["0xabc"]).toMatchObject({ priceUsd: 1.23 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches uncached multi-token market data and stores timed cache wrappers", async () => {
    const service = createService();
    const startedAt = Date.now();
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          "0xabc": {
            value: 2.5,
            priceInNative: 0.02,
            liquidity: 150,
            priceChange24h: -1.25,
          },
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await BirdeyeService.prototype.getTokensMarketData.call(
      service,
      "base",
      ["0xabc"],
      { notOlderThan: 30_000 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://birdeye.test/defi/multi_price?list_address=0xabc&include_liquidity=true",
      { headers: { accept: "application/json", "x-chain": "base" } },
    );
    expect(result["0xabc"]).toMatchObject({
      priceUsd: 2.5,
      priceSol: 0.02,
      liquidity: 150,
      priceChange24h: -1.25,
    });
    expect(service.runtime.setCache).toHaveBeenCalledWith(
      "birdeye_tokens_base_0xabc",
      expect.objectContaining({
        data: result["0xabc"],
      }),
    );
    expect(
      (service.runtime.setCache.mock.calls[0]?.[1] as { setAt: number }).setAt,
    ).toBeGreaterThanOrEqual(startedAt);
  });

  it("passes the requested chain to single-token market data requests", async () => {
    const service = createService();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: { price: 10, market_cap: 1000, liquidity: 500 },
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: { volumeUSD: 50 } }))
      .mockResolvedValueOnce(
        Response.json({ data: { items: [{ value: 9 }, { value: 10 }] } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await BirdeyeService.prototype.getTokenMarketData.call(
      service,
      "0xabc",
      "base",
    );

    expect(result).toMatchObject({
      price: 10,
      marketCap: 1000,
      liquidity: 500,
      volume24h: 50,
      priceHistory: [9, 10],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: { "x-chain": "base" },
      });
    }
  });
});

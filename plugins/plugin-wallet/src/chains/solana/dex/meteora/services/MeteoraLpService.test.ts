/**
 * A Meteora API outage is not "no pools".
 *
 * `LpManagementService.listPools` already refuses to turn a failed provider
 * lookup into an empty result ("A failed lookup is not an empty pool list" —
 * it rethrows when every provider failed and no pool came back). That contract
 * only holds if the provider throws: this adapter caught the fetch/HTTP/JSON
 * failure itself and resolved `[]`, so a dead Meteora API reached the caller as
 * a legitimately empty pool list.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeteoraLpService } from "./MeteoraLpService.ts";

function service(): MeteoraLpService {
  return new MeteoraLpService();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MeteoraLpService.getPools", () => {
  it("rejects when the Meteora pool API returns an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream unavailable", { status: 503 }))
    );

    await expect(service().getPools()).rejects.toThrow(/meteora/i);
  });

  it("rejects when the Meteora pool API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    await expect(service().getPools()).rejects.toThrow(/meteora/i);
  });

  it("still maps a successful pool payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                address: "pool-1",
                mint_x: "mintA",
                mint_y: "mintB",
                name_x: "A",
                name_y: "B",
                decimals_x: 6,
                decimals_y: 6,
                apr: 12,
                liquidity: "1000",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pools = await service().getPools();

    expect(pools).toEqual([
      {
        id: "pool-1",
        dex: "meteora",
        tokenA: { mint: "mintA", symbol: "A", decimals: 6 },
        tokenB: { mint: "mintB", symbol: "B", decimals: 6 },
        apy: 0.12,
        tvl: 1000,
      },
    ]);
  });
});

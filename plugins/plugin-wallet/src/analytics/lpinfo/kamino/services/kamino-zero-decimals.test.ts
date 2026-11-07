/**
 * A Birdeye token with 0 decimals is a real mint. `decimals || 9` priced it
 * as a 9-decimal token.
 */
import { describe, expect, it } from "vitest";
import { KaminoLiquidityService } from "./kaminoLiquidityService.js";

const ADDRESS = "So11111111111111111111111111111111111111112";

function serviceWithOverview(
  data: Record<string, unknown> | undefined,
): KaminoLiquidityService {
  const service = Object.create(
    KaminoLiquidityService.prototype,
  ) as KaminoLiquidityService;
  const harness = service as unknown as {
    runtime: {
      getService: () => {
        fetchTokenOverview: () => Promise<{ data?: Record<string, unknown> }>;
      };
    };
  };
  harness.runtime = {
    getService: () => ({
      fetchTokenOverview: async () => ({ data }),
    }),
  };
  return service;
}

describe("Kamino Birdeye token decimals", () => {
  it("keeps a token that has 0 decimals", async () => {
    const service = serviceWithOverview({
      name: "Zero",
      symbol: "Z",
      address: ADDRESS,
      price: 1,
      liquidity: 2,
      decimals: 0,
      mc: 3,
      volume24h: 4,
      priceChange24hPercent: 0,
    });

    const token = await service.resolveTokenWithBirdeye(ADDRESS);

    expect(token?.decimals).toBe(0);
  });

  it("uses 9 decimals when Birdeye omits the field", async () => {
    const service = serviceWithOverview({
      name: "Missing",
      symbol: "M",
      address: ADDRESS,
    });

    const token = await service.resolveTokenWithBirdeye(ADDRESS);

    expect(token?.decimals).toBe(9);
  });
});

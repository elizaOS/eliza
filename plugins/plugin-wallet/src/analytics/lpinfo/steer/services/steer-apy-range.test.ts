/**
 * A vault yield of 0% is recorded. `apy || apr` put another period's APR
 * into the liquidity range.
 */
import { describe, expect, it } from "vitest";
import type { SteerVaultDetailInput } from "../steer-display-types.js";
import { SteerLiquidityService } from "./steerLiquidityService.js";

const TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function vault(
  apy: number,
  apr: number,
): SteerVaultDetailInput {
  return {
    address: "0x1111111111111111111111111111111111111111",
    name: "vault",
    chainId: 1,
    tvl: 1,
    volume24h: 0,
    apy,
    apr,
    strategyType: "fixture",
    fee: 0,
    createdAt: 1,
    isActive: true,
  };
}

describe("Steer liquidity APY range", () => {
  it("does not replace a 0% yield with another period's APR", async () => {
    const service = Object.create(
      SteerLiquidityService.prototype,
    ) as SteerLiquidityService;
    const harness = service as unknown as {
      supportedChains: number[];
      getVaultsForToken: () => Promise<SteerVaultDetailInput[]>;
    };
    harness.supportedChains = [1];
    harness.getVaultsForToken = async () => [vault(0, 12), vault(4, 1)];

    const stats = await service.getTokenLiquidityStats(TOKEN, 1);

    expect(stats.apyRange).toEqual({ min: 4, max: 4 });
  });
});

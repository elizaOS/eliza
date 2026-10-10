/**
 * A recorded 0% yield is not the other rate. `apy || apr` told the
 * optimizer a dead position was still earning, or that a 0% pool was not.
 */

import type { LpPositionDetails, PoolInfo, TokenBalance } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { YieldOptimizationService } from "./YieldOptimizationService.js";

const MINT_A = "mintA";
const MINT_B = "mintB";

function token(address: string): TokenBalance {
  return { address, balance: "1", decimals: 6, symbol: address };
}

function position(apy: number, apr: number): LpPositionDetails {
  return {
    poolId: "pool-current",
    dex: "raydium",
    lpTokenBalance: token("lp"),
    underlyingTokens: [token(MINT_A), token(MINT_B)],
    valueUsd: 1_000,
    accruedFees: [],
    rewards: [],
    metadata: { apy, apr },
  };
}

function pool(apy: number, apr: number): PoolInfo {
  return {
    id: "pool-target",
    dex: "orca",
    tokenA: { mint: MINT_A, symbol: "A" },
    tokenB: { mint: MINT_B, symbol: "B" },
    apy,
    apr,
  };
}

function serviceWithPools(pools: PoolInfo[]): YieldOptimizationService {
  const service = Object.create(
    YieldOptimizationService.prototype,
  ) as YieldOptimizationService;
  const harness = service as unknown as {
    solPriceUsdForCosting: number;
    userLpProfileService: {
      getProfile: () => Promise<{
        autoRebalanceConfig: { minGainThresholdPercent: number };
      }>;
    };
    dexInteractionService: { getPools: () => Promise<PoolInfo[]> };
  };
  harness.solPriceUsdForCosting = 150;
  harness.userLpProfileService = {
    getProfile: async () => ({
      autoRebalanceConfig: { minGainThresholdPercent: 1 },
    }),
  };
  harness.dexInteractionService = {
    getPools: async () => pools,
  };
  return service;
}

describe("yield optimizer recorded zero", () => {
  it("does not treat a 0% position as if it were still earning APR", async () => {
    const service = serviceWithPools([pool(0.1, 0.01)]);
    const opportunities = await service.findBestYieldOpportunities(
      "user",
      [position(0, 0.4)],
      [],
    );
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.currentYield).toBe(0);
    expect(opportunities[0]?.estimatedNewYield).toBe(10);
  });

  it("does not cost a $0 position as if it were worth $1", async () => {
    const held = position(0, 0.4);
    held.valueUsd = 0;
    const service = serviceWithPools([pool(0.5, 0.01)]);
    const opportunities = await service.findBestYieldOpportunities(
      "user",
      [held],
      [],
    );
    expect(opportunities).toEqual([]);
  });

  it("does not recommend a pool whose APY is 0 because its APR is higher", async () => {
    const service = serviceWithPools([pool(0, 0.5)]);
    const opportunities = await service.findBestYieldOpportunities(
      "user",
      [position(0.2, 0.01)],
      [],
    );
    expect(opportunities).toEqual([]);
  });
});

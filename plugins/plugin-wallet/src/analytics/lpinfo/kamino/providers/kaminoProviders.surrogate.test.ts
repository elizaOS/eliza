/**
 * Surrogate safety for Kamino providers — exercises real providers at 8k/4k caps.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { kaminoLiquidityProvider } from "./kaminoLiquidityProvider.ts";
import { kaminoPoolProvider } from "./kaminoPoolProvider.ts";
import { kaminoProvider } from "./kaminoProvider.ts";

function isWellFormed(v: string): boolean {
  if (!v) return true;
  const maybe = v as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const fox = String.fromCharCode(0xd83e, 0xdd8a);
const loneHigh = String.fromCharCode(0xd800);

function makeLendingRuntime(poisonedModelOutput: string) {
  const mockKaminoService = {
    getUserPositions: async () => ({
      lending: [],
      borrowing: [],
      markets: [],
      userAccounts: 0,
    }),
    getAvailableReserves: async () => [],
    getMarketOverview: async () => null,
    discoverMarkets: async () => [],
  };
  const entity = {
    id: "entity-1",
    names: ["Alice"],
    metadata: {
      account: {
        username: "alice",
        name: "Alice",
        metawallets: [
          {
            keypairs: {
              solana: {
                publicKey: "So11111111111111111111111111111111111111112",
              },
            },
          },
        ],
      },
    },
  };
  return {
    getEntityById: async () => entity as never,
    getService: (name: string) =>
      name === "KAMINO_SERVICE" ? (mockKaminoService as never) : null,
    useModel: async () => poisonedModelOutput,
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;
}

function makePoolRuntime(poisonedModelOutput: string) {
  const poolData = {
    address: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",
    timestamp: Date.now(),
    strategy: {
      address: "strat1",
      strategyType: "test",
      estimatedTvl: 1000,
      volume24h: 100,
      apy: 5.5,
      feeTier: "0.3%",
      rebalancing: "auto",
      lastRebalance: Date.now(),
      tokenA: "SOL",
      tokenB: "USDC",
      positions: [],
    },
  };
  const mockLiquidityService = {
    getPoolByAddress: async () => poolData as never,
    testConnection: async () => ({
      connectionTest: true,
      programId: "Kamino",
      rpcEndpoint: "https://api.mainnet-beta.solana.com",
      strategyCount: 1,
    }),
  };
  return {
    getService: (name: string) =>
      name === "KAMINO_LIQUIDITY_SERVICE"
        ? (mockLiquidityService as never)
        : null,
    useModel: async () => poisonedModelOutput,
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;
}

function makeLiquidityRuntime(poisonedModelOutput: string) {
  const mockLiquidityService = {
    resolveTokenWithBirdeye: async (addr: string) => ({
      name: "Test Token",
      symbol: "TST",
      address: addr,
      price: 1,
      liquidity: 1000,
      marketCap: 10000,
      priceChange24h: 1.5,
      decimals: 6,
    }),
    getTokenLiquidityStats: async () => ({
      tokenName: "Test",
      totalTvl: 1000,
      totalVolume: 500,
      apyRange: { min: 1, max: 5 },
      strategies: [],
    }),
    getMarketStatistics: async () => ({
      timestamp: Date.now(),
      stakingYields: { total: 0, averageApy: 0, maxApy: 0, minApy: 0 },
      medianYields: { total: 0, averageApy: 0 },
      limoTrades: {
        total: 0,
        totalVolume: 0,
        averageTip: 0,
        averageSurplus: 0,
      },
    }),
    testConnection: async () => ({
      connectionTest: true,
      programId: "Kamino",
      rpcEndpoint: "https://api.mainnet-beta.solana.com",
      strategyCount: 1,
    }),
    getPoolByAddress: async () => null,
  };
  return {
    getService: (name: string) =>
      name === "KAMINO_LIQUIDITY_SERVICE"
        ? (mockLiquidityService as never)
        : null,
    useModel: async () => poisonedModelOutput,
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;
}

describe("Kamino providers surrogate safety via real providers", () => {
  it("KAMINO_LENDING: astral boundary at 8,000 via real provider", async () => {
    const poisoned = `${"a".repeat(7999)}${fox}${"b".repeat(200)}`;
    const runtime = makeLendingRuntime(poisoned);
    const message = {
      content: { text: "kamino", channelType: "DM" },
      entityId: "entity-1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(8000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("KAMINO_LENDING: lone surrogate sanitized via real provider", async () => {
    const poisoned = `Lending report ${loneHigh} broken ${"a".repeat(9000)}`;
    const runtime = makeLendingRuntime(poisoned);
    const message = {
      content: { text: "kamino", channelType: "DM" },
      entityId: "entity-1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.includes("\uD800")).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("KAMINO_POOL: astral boundary at 4,000 via real provider", async () => {
    const poisoned = `${"p".repeat(3999)}${fox}${"q".repeat(200)}`;
    const runtime = makePoolRuntime(poisoned);
    const message = {
      content: { text: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoPoolProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("KAMINO_POOL: lone surrogate sanitized via real provider", async () => {
    const poisoned = `Pool ${loneHigh} data ${"p".repeat(5000)}`;
    const runtime = makePoolRuntime(poisoned);
    const message = {
      content: { text: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoPoolProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.includes("\uD800")).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("KAMINO_LIQUIDITY: astral boundary at 4,000 via real provider", async () => {
    const poisoned = `${"l".repeat(3999)}${fox}${"x".repeat(200)}`;
    const runtime = makeLiquidityRuntime(poisoned);
    const message = {
      content: { text: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoLiquidityProvider.get(
      runtime,
      message,
      {} as State,
    );
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("KAMINO_LIQUIDITY: lone surrogate sanitized via real provider", async () => {
    const poisoned = `Liquidity ${loneHigh} stats ${"l".repeat(5000)}`;
    const runtime = makeLiquidityRuntime(poisoned);
    const message = {
      content: { text: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await kaminoLiquidityProvider.get(
      runtime,
      message,
      {} as State,
    );
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.includes("\uD800")).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

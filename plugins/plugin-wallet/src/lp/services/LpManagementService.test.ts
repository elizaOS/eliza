// @ts-nocheck — tests use plain objects instead of generated proto message instances
import { describe, expect, it, vi } from "vitest";
import {
  LpManagementService,
  type LpProtocolProvider,
  NoMatchingLpProtocolError,
} from "./LpManagementService.ts";

function createPool(dex: string) {
  return {
    id: `${dex}-pool`,
    dex,
    tokenA: {
      mint: "token-a",
      symbol: "A",
      decimals: 6,
    },
    tokenB: {
      mint: "token-b",
      symbol: "B",
      decimals: 6,
    },
  };
}

function createProvider(
  dex: string,
  chain: "solana" | "evm" = "solana",
): LpProtocolProvider {
  return {
    id: `${chain}:${dex}`,
    chain,
    dex,
    listPools: vi.fn(async () => [createPool(dex)]),
    openPosition: vi.fn(async () => ({
      success: true,
      transactionId: `${dex}-open`,
    })),
    closePosition: vi.fn(async () => ({
      success: true,
      transactionId: `${dex}-close`,
    })),
    repositionPosition: vi.fn(async () => ({
      success: true,
      transactionId: `${dex}-reposition`,
    })),
  };
}

describe("LpManagementService", () => {
  it("registers all supported DEX protocol providers", async () => {
    const registry = new LpManagementService();
    registry.registerProtocol(createProvider("raydium", "solana"));
    registry.registerProtocol(createProvider("orca", "solana"));
    registry.registerProtocol(createProvider("meteora", "solana"));
    registry.registerProtocol(createProvider("uniswap", "evm"));
    registry.registerProtocol(createProvider("aerodrome", "evm"));
    registry.registerProtocol(createProvider("pancakeswap", "evm"));

    expect(
      registry
        .listProtocols()
        .map((protocol) => `${protocol.chain}:${protocol.dex}`)
        .sort(),
    ).toEqual([
      "evm:aerodrome",
      "evm:pancakeswap",
      "evm:uniswap",
      "solana:meteora",
      "solana:orca",
      "solana:raydium",
    ]);
  });

  it("lists pools through the matching registered protocol", async () => {
    const registry = new LpManagementService();
    const provider = createProvider("orca");
    registry.registerProtocol(provider);

    const pools = await registry.listPools({
      chain: "solana",
      dex: "orca",
      tokenA: "token-a",
      tokenB: "token-b",
    });

    expect(pools).toEqual([createPool("orca")]);
    expect(provider.listPools).toHaveBeenCalledWith({
      chain: "solana",
      dex: "orca",
      tokenA: "token-a",
      tokenB: "token-b",
    });
  });

  it("routes open, close, and reposition to the selected protocol", async () => {
    const registry = new LpManagementService();
    const provider = createProvider("raydium");
    registry.registerProtocol(provider);

    await expect(
      registry.openPosition({
        chain: "solana",
        dex: "raydium",
        pool: "raydium-pool",
        amount: { tokenA: "100", tokenB: "200" },
      }),
    ).resolves.toMatchObject({ success: true, transactionId: "raydium-open" });

    await expect(
      registry.closePosition({
        chain: "solana",
        dex: "raydium",
        pool: "raydium-pool",
        amount: { lpToken: "50" },
      }),
    ).resolves.toMatchObject({ success: true, transactionId: "raydium-close" });

    await expect(
      registry.repositionPosition({
        chain: "solana",
        dex: "raydium",
        position: "position-1",
        range: { tickLower: -10, tickUpper: 10 },
      }),
    ).resolves.toMatchObject({
      success: true,
      transactionId: "raydium-reposition",
    });

    expect(provider.openPosition).toHaveBeenCalledTimes(1);
    expect(provider.closePosition).toHaveBeenCalledTimes(1);
    expect(provider.repositionPosition).toHaveBeenCalledTimes(1);
  });

  it("throws a no matching protocol error when no provider matches", async () => {
    const registry = new LpManagementService();
    registry.registerProtocol(createProvider("orca"));

    await expect(
      registry.openPosition({
        chain: "solana",
        dex: "meteora",
        pool: "missing-pool",
      }),
    ).rejects.toBeInstanceOf(NoMatchingLpProtocolError);
  });
});

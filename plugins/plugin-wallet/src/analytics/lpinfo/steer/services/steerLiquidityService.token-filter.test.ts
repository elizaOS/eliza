/**
 * Verifies token-address vault filtering through the production Steer
 * liquidity service with a deterministic SDK response boundary.
 */
import { describe, expect, it } from "vitest";
import type { SteerVaultDetailInput } from "../steer-display-types.js";
import { SteerLiquidityService } from "./steerLiquidityService.js";

const TARGET_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MATCHING_VAULT = "0x1111111111111111111111111111111111111111";
const UNRELATED_VAULT = "0x2222222222222222222222222222222222222222";

const rawVaults = [
  {
    address: MATCHING_VAULT,
    token0: TARGET_TOKEN.toUpperCase(),
    token1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    poolAddress: "0x3111111111111111111111111111111111111111",
  },
  {
    address: UNRELATED_VAULT,
    token0: "0xcccccccccccccccccccccccccccccccccccccccc",
    token1: "0xdddddddddddddddddddddddddddddddddddddddd",
    poolAddress: "0x3222222222222222222222222222222222222222",
  },
] as const;

type ServiceHarness = {
  supportedChains: number[];
  vaultClients: Map<
    number,
    {
      getVaults: () => Promise<{
        success: true;
        data: { edges: Array<{ node: (typeof rawVaults)[number] }> };
      }>;
    }
  >;
  processVaultData: (
    vault: (typeof rawVaults)[number],
    chainId: number,
  ) => Promise<SteerVaultDetailInput>;
};

function serviceWithVaults(): SteerLiquidityService {
  const service = Object.create(
    SteerLiquidityService.prototype,
  ) as SteerLiquidityService;
  const harness = service as unknown as ServiceHarness;
  harness.supportedChains = [1];
  harness.vaultClients = new Map([
    [
      1,
      {
        getVaults: async () => ({
          success: true,
          data: { edges: rawVaults.map((node) => ({ node })) },
        }),
      },
    ],
  ]);
  harness.processVaultData = async (vault, chainId) => ({
    ...vault,
    chainId,
    name: vault.address,
    fee: 0,
    tvl: 1,
    volume24h: 0,
    apy: 0,
    isActive: true,
    createdAt: 0,
    strategyType: "fixture-boundary",
    positions: [],
    ammType: "UniswapV3",
  });
  return service;
}

describe("Steer token-address vault filtering", () => {
  it("returns only direct token members and does not broaden an unknown address", async () => {
    const service = serviceWithVaults();

    const known = await service.getTokenLiquidityStats(TARGET_TOKEN, 1);
    const unknown = await service.getTokenLiquidityStats(
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      1,
    );

    expect(known.vaults.map((vault) => vault.address)).toEqual([
      MATCHING_VAULT,
    ]);
    expect(unknown.vaults).toEqual([]);
  });
});

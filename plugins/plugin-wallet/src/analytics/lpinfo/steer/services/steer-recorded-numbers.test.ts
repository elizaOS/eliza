/**
 * A Steer subgraph zero is a recorded value. `parseInt(...) || 18` treated a
 * 0-decimal token as 18, `feeTier || 3000` treated a 0-fee pool as 30 bps,
 * and `apy || apr` replaced a 0% yield with another period.
 */
import { describe, expect, it } from "vitest";
import { SteerLiquidityService } from "./steerLiquidityService.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function bareService(): SteerLiquidityService {
  return Object.create(
    SteerLiquidityService.prototype,
  ) as SteerLiquidityService;
}

function graphqlVault(over: Record<string, unknown> = {}) {
  return {
    id: ADDRESS,
    name: "Zero",
    token0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    token1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pool: "0xcccccccccccccccccccccccccccccccccccccccc",
    weeklyFeeAPR: "0",
    token0Symbol: "Z",
    token0Decimals: "0",
    token1Symbol: "U",
    token1Decimals: "6",
    token0Balance: "5",
    token1Balance: "1000000",
    totalLPTokensIssued: "1",
    feeTier: "0",
    fees0: "0",
    fees1: "0",
    strategyToken: {
      id: "s",
      name: "s",
      creator: { id: "c" },
      admin: "a",
      executionBundle: "b",
    },
    beaconName: "b",
    payloadIpfs: "",
    deployer: "d",
    ...over,
  };
}

describe("Steer recorded zeros", () => {
  it("keeps 0 token decimals and a 0 fee tier when pricing a vault", async () => {
    const service = bareService();
    const harness = service as unknown as {
      getVaultDataFromGraphQL: () => Promise<ReturnType<typeof graphqlVault>>;
    };
    harness.getVaultDataFromGraphQL = async () => graphqlVault();

    const vault = await service.getVaultDetails(ADDRESS, 1);

    expect(vault?.fee).toBe(0);
    // 5 units at 0 decimals + 1_000_000 units at 6 decimals.
    expect(vault?.tvl).toBe(6);
  });

  it("keeps the 18-decimal fallback when the subgraph omits decimals", async () => {
    const service = bareService();
    const harness = service as unknown as {
      getVaultDataFromGraphQL: () => Promise<ReturnType<typeof graphqlVault>>;
    };
    harness.getVaultDataFromGraphQL = async () =>
      graphqlVault({
        token0Decimals: "",
        token1Decimals: "",
        token0Balance: "1000000000000000000",
        token1Balance: "0",
        feeTier: "",
      });

    const vault = await service.getVaultDetails(ADDRESS, 1);

    expect(vault?.tvl).toBe(1);
    expect(vault?.fee).toBe(0.3);
  });

  it("keeps a 0% yield and an epoch createdAt string", async () => {
    const service = bareService();
    const harness = service as unknown as {
      getVaultDataFromGraphQL: () => Promise<null>;
      processVaultData: (
        vault: {
          address: string;
          pool: { feeTier: string };
          apy: number;
          apr: number;
          createdAt: string;
        },
        chainId: number,
      ) => Promise<{ apy: number; createdAt: number; fee: number } | null>;
    };
    harness.getVaultDataFromGraphQL = async () => null;

    const vault = await harness.processVaultData(
      {
        address: ADDRESS,
        pool: { feeTier: "0" },
        apy: 0,
        apr: 12,
        createdAt: "0",
      },
      1,
    );

    expect(vault?.apy).toBe(0);
    expect(vault?.createdAt).toBe(0);
    expect(vault?.fee).toBe(0);
  });
});

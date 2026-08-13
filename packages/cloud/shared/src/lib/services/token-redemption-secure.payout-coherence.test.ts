/**
 * Verifies the secure-redemption availability gate uses the staging payout
 * chain, RPC, token contract, and decimals as one coherent configuration.
 */

import { afterAll, expect, mock, test } from "bun:test";
import * as realViem from "viem";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";

const walletAddress = "0x0000000000000000000000000000000000000001";
let clientChainId: number | undefined;
let balanceTokenAddress: string | undefined;

mock.module("../../db/client", () => ({ dbRead: {}, dbWrite: {} }));
mock.module("viem", () => ({
  ...realViem,
  createPublicClient: (config: { chain?: { id: number } }) => {
    clientChainId = config.chain?.id;
    return {
      readContract: async (request: { address: string }) => {
        balanceTokenAddress = request.address;
        return 12_500_000n;
      },
    };
  },
}));

const { SecureTokenRedemptionService } = await import("./token-redemption-secure");

afterAll(() => {
  mock.module("viem", () => realViem);
});

test("Base staging USDC availability reads Base Sepolia USDC with 6 decimals", async () => {
  const service = new SecureTokenRedemptionService();

  const result = await runWithCloudBindingsAsync(
    {
      ENVIRONMENT: "staging",
      NODE_ENV: "production",
      PAYOUT_TESTNET: "true",
      BASE_RPC_URL: "https://mainnet.example/base",
      BASE_SEPOLIA_RPC_URL: "https://testnet.example/base",
      EVM_PAYOUT_WALLET_ADDRESS: walletAddress,
    },
    () => service.checkTokenAvailability("base", 10, "usdc"),
  );

  expect(result).toEqual({ available: true, balance: 12.5 });
  expect(clientChainId).toBe(84532);
  expect(balanceTokenAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
});

test("redemption requests reject non-Base-USDC launch rails before database access", async () => {
  const service = new SecureTokenRedemptionService();
  const common = {
    userId: "00000000-0000-4000-8000-000000000001",
    pointsAmount: 100,
    payoutAddress: walletAddress,
    metadata: { ipAddress: "203.0.113.1" },
  };

  const solana = await service.createRedemption({
    ...common,
    network: "solana",
    asset: "usdc",
  });
  const legacy = await service.createRedemption({
    ...common,
    network: "base",
    asset: "eliza",
  });

  expect(solana.success).toBe(false);
  expect(solana.error).toContain("USDC on base only");
  expect(legacy.success).toBe(false);
  expect(legacy.error).toContain("USDC on base only");
});

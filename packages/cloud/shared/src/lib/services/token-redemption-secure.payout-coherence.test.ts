/**
 * Verifies the secure-redemption availability gate uses the staging payout
 * chain, RPC, token contract, and decimals as one coherent configuration.
 */

import { afterAll, expect, mock, test } from "bun:test";
import * as realViem from "viem";
import * as realCloudBindings from "../runtime/cloud-bindings";

const originalPayoutTestnet = process.env.PAYOUT_TESTNET;
process.env.PAYOUT_TESTNET = "true";

const walletAddress = "0x0000000000000000000000000000000000000001";
let clientChainId: number | undefined;
let balanceTokenAddress: string | undefined;

mock.module("../../db/client", () => ({ dbRead: {}, dbWrite: {} }));
mock.module("../runtime/cloud-bindings", () => ({
  ...realCloudBindings,
  getCloudAwareEnv: () => ({
    ...process.env,
    ENVIRONMENT: "staging",
    BASE_RPC_URL: "https://mainnet.example/base",
    BASE_SEPOLIA_RPC_URL: "https://testnet.example/base",
    EVM_PAYOUT_WALLET_ADDRESS: walletAddress,
  }),
}));
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
  if (originalPayoutTestnet === undefined) delete process.env.PAYOUT_TESTNET;
  else process.env.PAYOUT_TESTNET = originalPayoutTestnet;
  mock.module("viem", () => realViem);
  mock.module("../runtime/cloud-bindings", () => realCloudBindings);
});

test("Base staging USDC availability reads Base Sepolia USDC with 6 decimals", async () => {
  const service = new SecureTokenRedemptionService();

  const result = await service.checkTokenAvailability("base", 10, "usdc");

  expect(result).toEqual({ available: true, balance: 12.5 });
  expect(clientChainId).toBe(84532);
  expect(balanceTokenAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
});

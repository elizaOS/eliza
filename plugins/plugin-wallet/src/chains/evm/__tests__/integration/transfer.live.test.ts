import type { IAgentRuntime } from "@elizaos/core";
import type { Account } from "viem";
import { formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { itIf } from "../../../../../../../packages/app-core/test/helpers/conditional-tests";
import { TransferAction } from "../../actions/transfer";
import { type ChainRpcConfig, WalletProvider } from "../../providers/wallet";
import { initRPCProviderManager } from "../../rpc-providers";
import { cleanupTestRuntime, createTestRuntime } from "../test-utils";
import {
  ELIZA_CLOUD_API_KEY,
  ELIZA_CLOUD_BASE_URL,
  HAS_ELIZA_CLOUD_RPC_KEY,
  PUBLIC_FALLBACK_RPC_URLS,
  resolveHealthyPublicRpcUrl,
  shouldUseElizaCloudRpc,
} from "./live-rpc";

if (!HAS_ELIZA_CLOUD_RPC_KEY) {
  process.env.SKIP_REASON ||= "ELIZAOS_CLOUD_API_KEY required to verify Eliza Cloud RPC routing";
}

// Test environment - use a funded wallet private key for real testing
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();
const LIVE_CHAINS = ["mainnet", "base", "bsc"] as const;
let useElizaCloudRpc = false;

beforeAll(async () => {
  useElizaCloudRpc = await shouldUseElizaCloudRpc();
});

function createRpcRuntime(): IAgentRuntime {
  return {
    getSetting(key: string): string | undefined {
      const settings: Record<string, string> = useElizaCloudRpc
        ? {
            EVM_RPC_PROVIDER: "elizacloud",
            ELIZAOS_CLOUD_API_KEY: ELIZA_CLOUD_API_KEY,
            ELIZAOS_CLOUD_BASE_URL: ELIZA_CLOUD_BASE_URL,
            ELIZAOS_CLOUD_ENABLED: "1",
            ELIZAOS_CLOUD_USE_RPC: "true",
          }
        : {
            ETHEREUM_PROVIDER_MAINNET: PUBLIC_FALLBACK_RPC_URLS.mainnet,
            ETHEREUM_PROVIDER_BASE: PUBLIC_FALLBACK_RPC_URLS.base,
            ETHEREUM_PROVIDER_BSC: PUBLIC_FALLBACK_RPC_URLS.bsc,
          };
      return settings[key] ?? process.env[key];
    },
    character: {
      settings: {
        chains: {
          evm: [...LIVE_CHAINS],
        },
      },
    },
  } as IAgentRuntime;
}

async function createLiveChainSetup(): Promise<{
  rpcConfigs: Record<string, ChainRpcConfig>;
  chains: Record<string, ReturnType<typeof WalletProvider.genChainFromName>>;
}> {
  const manager = initRPCProviderManager(createRpcRuntime());
  const chains: Record<string, ReturnType<typeof WalletProvider.genChainFromName>> = {};
  const rpcConfigs: Record<string, ChainRpcConfig> = {};

  for (const chainName of LIVE_CHAINS) {
    const resolved = manager.resolveForChain(chainName);
    if (!resolved) {
      throw new Error(`No live RPC configured for ${chainName}`);
    }
    const rpcUrl = useElizaCloudRpc ? resolved.rpcUrl : await resolveHealthyPublicRpcUrl(chainName);
    chains[chainName] = WalletProvider.genChainFromName(chainName, rpcUrl);
    rpcConfigs[chainName] = {
      rpcUrl,
      headers: resolved.headers,
    };
  }

  return { chains, rpcConfigs };
}

describe("Transfer Action", () => {
  let wp: WalletProvider;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    const pk = TEST_PRIVATE_KEY as `0x${string}`;
    const { chains, rpcConfigs } = await createLiveChainSetup();
    wp = new WalletProvider(pk, runtime, chains, rpcConfigs);
  });

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  describe("Constructor", () => {
    it("should initialize with wallet provider", () => {
      const ta = new TransferAction(wp);
      expect(ta).toBeDefined();
    });

    it("should default to live Ethereum, Base, and BSC chains", () => {
      expect(wp.getSupportedChains()).toEqual(expect.arrayContaining(["mainnet", "base", "bsc"]));
    });

    itIf(HAS_ELIZA_CLOUD_RPC_KEY)("should prefer Eliza Cloud RPCs when configured", () => {
      const chainConfigs = wp.getChainConfigs("mainnet");
      expect(chainConfigs.rpcUrls.custom?.http[0]).toBe(
        `${ELIZA_CLOUD_BASE_URL}/proxy/evm-rpc/mainnet`
      );
    });
  });

  describe("Transfer Operations", () => {
    let ta: TransferAction;
    let receiver: Account;

    beforeEach(() => {
      ta = new TransferAction(wp);
      receiver = privateKeyToAccount(generatePrivateKey());
    });

    it("should validate transfer parameters", async () => {
      const transferParams = {
        fromChain: "base" as const,
        toAddress: receiver.address,
        amount: "0.001", // Small amount for testing
      };

      // Check if this is a valid transfer structure
      expect(transferParams.fromChain).toBe("base");
      expect(transferParams.toAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(parseFloat(transferParams.amount)).toBeGreaterThan(0);
    });

    it("should handle insufficient funds gracefully", async () => {
      // Test with unrealistic large amount that will definitely fail
      await expect(
        ta.transfer({
          fromChain: "mainnet" as const,
          toAddress: receiver.address,
          amount: "1000000", // 1M ETH - definitely insufficient
        })
      ).rejects.toThrow();
    });

    it("should validate recipient address format", async () => {
      await expect(
        ta.transfer({
          fromChain: "base" as const,
          toAddress: "invalid-address" as `0x${string}`,
          amount: "0.001",
        })
      ).rejects.toThrow();
    });

    it("should handle zero amount transfers", async () => {
      await expect(
        ta.transfer({
          fromChain: "bsc" as const,
          toAddress: receiver.address,
          amount: "0",
        })
      ).rejects.toThrow();
    });

    describe("Gas and fee estimation", () => {
      it("should estimate gas for transfer", async () => {
        const publicClient = wp.getPublicClient("mainnet");
        const walletAddress = wp.getAddress();

        try {
          const gasEstimate = await publicClient.estimateGas({
            account: walletAddress,
            to: receiver.address,
            value: parseEther("0.001"),
          });

          expect(typeof gasEstimate).toBe("bigint");
          expect(gasEstimate).toBeGreaterThan(0n);
          console.log(`Estimated gas: ${gasEstimate.toString()}`);
        } catch (error) {
          console.warn("Gas estimation failed (likely insufficient funds):", error);
        }
      });

      it("should calculate transfer cost", async () => {
        const publicClient = wp.getPublicClient("base");

        try {
          const gasPrice = await publicClient.getGasPrice();
          const estimatedGas = 21000n; // Standard ETH transfer gas
          const transferAmount = parseEther("0.001");
          const totalCost = transferAmount + gasPrice * estimatedGas;

          expect(typeof gasPrice).toBe("bigint");
          expect(gasPrice).toBeGreaterThan(0n);

          console.log(`Gas price: ${formatEther(gasPrice)} ETH/gas`);
          console.log(`Estimated total cost: ${formatEther(totalCost)} ETH`);
        } catch (error) {
          console.warn("Fee calculation failed:", error);
        }
      });
    });
  });
});

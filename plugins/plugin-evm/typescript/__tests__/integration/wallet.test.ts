import type { IAgentRuntime } from "@elizaos/core";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletProvider } from "../../providers/wallet";
import type { SupportedChain } from "../../types";
import {
  ANVIL_ADDRESS,
  ANVIL_PRIVATE_KEY,
  baseSepolia,
  getAnvilChain,
  getTestChains,
  sepolia,
} from "../custom-chain";
import { cleanupTestRuntime, createTestRuntime } from "../test-utils";

// Helper function to check if Anvil is running
async function isAnvilRunning(): Promise<boolean> {
  try {
    const client = createPublicClient({
      transport: http("http://127.0.0.1:8545"),
    });
    await client.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}

// Test environment variables - in real tests you'd use a funded testnet wallet
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();
const TEST_RPC_URLS = {
  sepolia: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  optimismSepolia: process.env.OP_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
  anvil: "http://127.0.0.1:8545",
};

// Store runtimes for cleanup
let runtimesToCleanup: IAgentRuntime[] = [];

/**
 * Creates a real AgentRuntime with spied methods for EVM testing.
 */
async function createEVMTestRuntime(): Promise<IAgentRuntime> {
  const runtime = await createTestRuntime();
  runtimesToCleanup.push(runtime);

  // Spy on methods used by WalletProvider
  vi.spyOn(runtime, "getCache").mockResolvedValue(null);
  vi.spyOn(runtime, "setCache").mockResolvedValue(true);
  vi.spyOn(runtime, "getSetting").mockReturnValue(null);
  vi.spyOn(runtime, "setSetting").mockImplementation(() => {});
  vi.spyOn(runtime, "getService").mockReturnValue(null);
  vi.spyOn(runtime, "registerService").mockResolvedValue(undefined);

  // Spy on logger methods
  vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
  vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
  vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
  vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});

  return runtime;
}

describe("Wallet Provider", () => {
  let walletProvider: WalletProvider;
  let pk: `0x${string}`;
  const testChains = getTestChains();

  beforeAll(() => {
    pk = TEST_PRIVATE_KEY as `0x${string}`;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    for (const rt of runtimesToCleanup) {
      await cleanupTestRuntime(rt);
    }
    runtimesToCleanup = [];
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Constructor", () => {
    it("should set wallet address correctly", async () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;
      const agentRuntime = await createEVMTestRuntime();

      walletProvider = new WalletProvider(pk, agentRuntime);

      expect(walletProvider.getAddress()).toBe(expectedAddress);
    });

    it("should initialize with empty chains when no chains provided", async () => {
      const agentRuntime = await createEVMTestRuntime();
      walletProvider = new WalletProvider(pk, agentRuntime);

      // WalletProvider constructor with no chains should result in empty chains
      const supportedChains = walletProvider.getSupportedChains();
      expect(supportedChains.length).toBe(0);

      // This is expected behavior - no chains configured means no chains
      expect(supportedChains.includes("mainnet" as SupportedChain)).toBe(false);
    });

    it("should initialize with custom testnet chains", async () => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };
      const agentRuntime = await createEVMTestRuntime();

      walletProvider = new WalletProvider(pk, agentRuntime, customChains);

      expect(walletProvider.chains.sepolia.id).toEqual(sepolia.id);
      expect(walletProvider.chains.baseSepolia.id).toEqual(baseSepolia.id);
    });
  });

  describe("Public and Wallet Clients", () => {
    beforeEach(async () => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };
      walletProvider = new WalletProvider(pk, await createEVMTestRuntime(), customChains);
    });

    it("should generate public client for Sepolia", () => {
      const client = walletProvider.getPublicClient("sepolia");
      expect(client.chain.id).toEqual(sepolia.id);
      expect(client.chain.testnet).toBe(true);
    });

    it("should generate public client with custom RPC URL", async () => {
      const chain = WalletProvider.genChainFromName("sepolia", TEST_RPC_URLS.sepolia);
      const wp = new WalletProvider(pk, await createEVMTestRuntime(), {
        sepolia: chain,
      });

      const client = wp.getPublicClient("sepolia");
      expect(client.chain.id).toEqual(sepolia.id);
      expect(client.transport.url).toEqual(TEST_RPC_URLS.sepolia);
    });

    it("should generate wallet client for Sepolia", () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;

      const client = walletProvider.getWalletClient("sepolia");

      expect(client.account).toBeDefined();
      expect(client.chain).toBeDefined();
      expect(client.account?.address).toEqual(expectedAddress);
      expect(client.chain?.id).toEqual(sepolia.id);
    });

    it("should generate wallet client with custom RPC URL", async () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;
      const chain = WalletProvider.genChainFromName("sepolia", TEST_RPC_URLS.sepolia);
      const wp = new WalletProvider(pk, await createEVMTestRuntime(), {
        sepolia: chain,
      });

      const client = wp.getWalletClient("sepolia");

      expect(client.account).toBeDefined();
      expect(client.chain).toBeDefined();
      expect(client.account?.address).toEqual(expectedAddress);
      expect(client.chain?.id).toEqual(sepolia.id);
      expect(client.transport.url).toEqual(TEST_RPC_URLS.sepolia);
    });
  });

  describe("Balance Operations", () => {
    beforeEach(async () => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };
      walletProvider = new WalletProvider(pk, await createEVMTestRuntime(), customChains);
    });

    it("should fetch balance for Sepolia testnet", async () => {
      const balance = await walletProvider.getWalletBalanceForChain("sepolia");

      // Balance should be a string representing ETH amount
      expect(typeof balance).toBe("string");
      expect(balance).toMatch(/^\d+(\.\d+)?$/); // Should be a valid number string
    });

    it("should fetch balance for Base Sepolia testnet", async () => {
      const balance = await walletProvider.getWalletBalanceForChain("baseSepolia");

      expect(typeof balance).toBe("string");
      expect(balance).toMatch(/^\d+(\.\d+)?$/);
    });

    it("should return null for unconfigured chain", async () => {
      const balance = await walletProvider.getWalletBalanceForChain(
        "unconfiguredChain" as SupportedChain
      );
      expect(balance).toBe(null);
    });

    it("should fetch all wallet balances", async () => {
      const balances = await walletProvider.getWalletBalances();

      expect(typeof balances).toBe("object");
      expect(balances.sepolia).toBeDefined();
      expect(balances.baseSepolia).toBeDefined();
      expect(typeof balances.sepolia).toBe("string");
      expect(typeof balances.baseSepolia).toBe("string");
    });
  });

  describe("Chain Management", () => {
    beforeEach(async () => {
      walletProvider = new WalletProvider(pk, await createEVMTestRuntime());
    });

    it("should generate chain from name - Sepolia", () => {
      const chain = WalletProvider.genChainFromName("sepolia");

      expect(chain.id).toEqual(sepolia.id);
      expect(chain.name).toEqual(sepolia.name);
      expect(chain.testnet).toBe(true);
    });

    it("should generate chain from name with custom RPC URL", () => {
      const customRpcUrl = TEST_RPC_URLS.sepolia;
      const chain = WalletProvider.genChainFromName("sepolia", customRpcUrl);

      expect(chain.id).toEqual(sepolia.id);
      expect(chain.rpcUrls.custom.http[0]).toEqual(customRpcUrl);
    });

    it("should add new chains dynamically", () => {
      const initialChains = Object.keys(walletProvider.chains);
      expect(initialChains).not.toContain("sepolia");

      walletProvider.addChain({ sepolia: testChains.sepolia });

      const newChains = Object.keys(walletProvider.chains);
      expect(newChains).toContain("sepolia");
    });

    it("should get chain configurations", () => {
      walletProvider.addChain({ sepolia: testChains.sepolia });
      const chainConfig = walletProvider.getChainConfigs("sepolia");

      expect(chainConfig.id).toEqual(sepolia.id);
      expect(chainConfig.name).toEqual(sepolia.name);
    });

    it("should get supported chains list", () => {
      walletProvider.addChain({
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      });

      const supportedChains = walletProvider.getSupportedChains();
      expect(supportedChains).toContain("sepolia");
      expect(supportedChains).toContain("baseSepolia");
    });

    it("should throw error for unsupported chain name", () => {
      expect(() => WalletProvider.genChainFromName("invalidchain" as SupportedChain)).toThrow();
    });

    it("should throw error for invalid chain name format", () => {
      expect(() => WalletProvider.genChainFromName("123invalid" as SupportedChain)).toThrow();
    });
  });

  describe("Network Connectivity", () => {
    beforeEach(async () => {
      const customChains = {
        sepolia: testChains.sepolia,
      };
      walletProvider = new WalletProvider(pk, await createEVMTestRuntime(), customChains);
    });

    it("should be able to connect to Sepolia network", async () => {
      const publicClient = walletProvider.getPublicClient("sepolia");

      try {
        const blockNumber = await publicClient.getBlockNumber();
        expect(typeof blockNumber).toBe("bigint");
        expect(blockNumber).toBeGreaterThan(0n);
      } catch (error) {
        // Skip test if network is unreachable
        console.warn("Sepolia network unreachable:", error);
      }
    });

    it("should be able to get chain ID from network", async () => {
      const publicClient = walletProvider.getPublicClient("sepolia");

      try {
        const chainId = await publicClient.getChainId();
        expect(chainId).toEqual(sepolia.id);
      } catch (error) {
        console.warn("Sepolia network unreachable:", error);
      }
    });
  });

  describe("Local Anvil Tests (Funded)", () => {
    let anvilProvider: WalletProvider;
    let anvilAvailable = false;

    beforeEach(async () => {
      anvilAvailable = await isAnvilRunning();
      if (!anvilAvailable) {
        return;
      }
      anvilProvider = new WalletProvider(
        ANVIL_PRIVATE_KEY,
        await createEVMTestRuntime(),
        getAnvilChain()
      );
    });

    it("should connect to local Anvil node", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const publicClient = anvilProvider.getPublicClient("anvil" as SupportedChain);
      const blockNumber = await publicClient.getBlockNumber();
      expect(typeof blockNumber).toBe("bigint");
    });

    it("should have correct Anvil address", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      expect(anvilProvider.getAddress()).toBe(ANVIL_ADDRESS);
    });

    it("should have funded balance on Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const balance = await anvilProvider.getWalletBalanceForChain("anvil" as SupportedChain);
      expect(balance).not.toBeNull();
      if (balance !== null) {
        expect(parseFloat(balance)).toBeGreaterThan(0);
      }
      console.log(`Anvil balance: ${balance} ETH`);
    });

    it("should get chain ID from Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const publicClient = anvilProvider.getPublicClient("anvil" as SupportedChain);
      const chainId = await publicClient.getChainId();
      expect(chainId).toBe(31337);
    });
  });
});

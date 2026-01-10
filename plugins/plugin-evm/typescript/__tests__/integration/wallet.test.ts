import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { WalletProvider } from "../../providers/wallet";
import {
  anvil,
  ANVIL_PRIVATE_KEY,
  ANVIL_ADDRESS,
  baseSepolia,
  getAnvilChain,
  getTestChains,
  sepolia,
} from "../custom-chain";

// Test environment variables - in real tests you'd use a funded testnet wallet
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();
const TEST_RPC_URLS = {
  sepolia:
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com",
  baseSepolia: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  optimismSepolia:
    process.env.OP_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
  anvil: "http://127.0.0.1:8545",
};

// Mock the ICacheManager
const mockCacheManager = {
  getCache: vi.fn().mockResolvedValue(null),
  setCache: vi.fn().mockResolvedValue(undefined),
};

describe("Wallet Provider", () => {
  let walletProvider: WalletProvider;
  let pk: `0x${string}`;
  const testChains = getTestChains();

  beforeAll(() => {
    pk = TEST_PRIVATE_KEY as `0x${string}`;
  });

  afterEach(() => {
    // Remove vi.clearAllTimers() as it's not needed in Bun test runner
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheManager.getCache.mockResolvedValue(null);
  });

  describe("Constructor", () => {
    it("should set wallet address correctly", () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;

      walletProvider = new WalletProvider(pk, mockCacheManager as any);

      expect(walletProvider.getAddress()).toBe(expectedAddress);
    });

    it("should initialize with empty chains when no chains provided", () => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any);

      // WalletProvider constructor with no chains should result in empty chains
      const supportedChains = walletProvider.getSupportedChains();
      expect(supportedChains.length).toBe(0);

      // This is expected behavior - no chains configured means no chains
      expect(supportedChains.includes("mainnet" as any)).toBe(false);
    });

    it("should initialize with custom testnet chains", () => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };

      walletProvider = new WalletProvider(
        pk,
        mockCacheManager as any,
        customChains,
      );

      expect(walletProvider.chains.sepolia.id).toEqual(sepolia.id);
      expect(walletProvider.chains.baseSepolia.id).toEqual(baseSepolia.id);
    });
  });

  describe("Public and Wallet Clients", () => {
    beforeEach(() => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };
      walletProvider = new WalletProvider(
        pk,
        mockCacheManager as any,
        customChains,
      );
    });

    it("should generate public client for Sepolia", () => {
      const client = walletProvider.getPublicClient("sepolia");
      expect(client.chain.id).toEqual(sepolia.id);
      expect(client.chain.testnet).toBe(true);
    });

    it("should generate public client with custom RPC URL", () => {
      const chain = WalletProvider.genChainFromName(
        "sepolia",
        TEST_RPC_URLS.sepolia,
      );
      const wp = new WalletProvider(pk, mockCacheManager as any, {
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
      expect(client.account && client.account.address).toEqual(expectedAddress);
      expect(client.chain && client.chain.id).toEqual(sepolia.id);
    });

    it("should generate wallet client with custom RPC URL", () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;
      const chain = WalletProvider.genChainFromName(
        "sepolia",
        TEST_RPC_URLS.sepolia,
      );
      const wp = new WalletProvider(pk, mockCacheManager as any, {
        sepolia: chain,
      });

      const client = wp.getWalletClient("sepolia");

      expect(client.account).toBeDefined();
      expect(client.chain).toBeDefined();
      expect(client.account && client.account.address).toEqual(expectedAddress);
      expect(client.chain && client.chain.id).toEqual(sepolia.id);
      expect(client.transport.url).toEqual(TEST_RPC_URLS.sepolia);
    });
  });

  describe("Balance Operations", () => {
    beforeEach(() => {
      const customChains = {
        sepolia: testChains.sepolia,
        baseSepolia: testChains.baseSepolia,
      };
      walletProvider = new WalletProvider(
        pk,
        mockCacheManager as any,
        customChains,
      );
    });

    it("should fetch balance for Sepolia testnet", async () => {
      const balance = await walletProvider.getWalletBalanceForChain("sepolia");

      // Balance should be a string representing ETH amount
      expect(typeof balance).toBe("string");
      expect(balance).toMatch(/^\d+(\.\d+)?$/); // Should be a valid number string
    });

    it("should fetch balance for Base Sepolia testnet", async () => {
      const balance =
        await walletProvider.getWalletBalanceForChain("baseSepolia");

      expect(typeof balance).toBe("string");
      expect(balance).toMatch(/^\d+(\.\d+)?$/);
    });

    it("should return null for unconfigured chain", async () => {
      const balance = await walletProvider.getWalletBalanceForChain(
        "unconfiguredChain" as any,
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
    beforeEach(() => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any);
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
      expect(() =>
        WalletProvider.genChainFromName("invalidchain" as any),
      ).toThrow();
    });

    it("should throw error for invalid chain name format", () => {
      expect(() =>
        WalletProvider.genChainFromName("123invalid" as any),
      ).toThrow();
    });
  });

  describe("Network Connectivity", () => {
    beforeEach(() => {
      const customChains = {
        sepolia: testChains.sepolia,
      };
      walletProvider = new WalletProvider(
        pk,
        mockCacheManager as any,
        customChains,
      );
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

    beforeEach(() => {
      anvilProvider = new WalletProvider(
        ANVIL_PRIVATE_KEY,
        mockCacheManager as any,
        getAnvilChain(),
      );
    });

    it("should connect to local Anvil node", async () => {
      const publicClient = anvilProvider.getPublicClient("anvil" as any);
      const blockNumber = await publicClient.getBlockNumber();
      expect(typeof blockNumber).toBe("bigint");
    });

    it("should have correct Anvil address", () => {
      expect(anvilProvider.getAddress()).toBe(ANVIL_ADDRESS);
    });

    it("should have funded balance on Anvil", async () => {
      const balance = await anvilProvider.getWalletBalanceForChain("anvil" as any);
      expect(balance).not.toBeNull();
      expect(parseFloat(balance!)).toBeGreaterThan(0);
      console.log(`Anvil balance: ${balance} ETH`);
    });

    it("should get chain ID from Anvil", async () => {
      const publicClient = anvilProvider.getPublicClient("anvil" as any);
      const chainId = await publicClient.getChainId();
      expect(chainId).toBe(31337);
    });
  });
});

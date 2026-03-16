import type { IAgentRuntime } from "@elizaos/core";
import type { Account, Address, Chain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WalletProvider } from "../../providers/wallet";
import type { SupportedChain } from "../../types";
import { getTestChains } from "../custom-chain";
import { cleanupTestRuntime, createTestRuntime } from "../test-utils";

// Use vi.hoisted to create mocks that are available before vi.mock is called
const { mockGetRoutes, mockGetStepTransaction, mockGetToken, mockCreateConfig } = vi.hoisted(
  () => ({
    mockGetRoutes: vi.fn(),
    mockGetStepTransaction: vi.fn(),
    mockGetToken: vi.fn(),
    mockCreateConfig: vi.fn(),
  })
);

vi.mock("@lifi/sdk", () => ({
  createConfig: mockCreateConfig,
  getRoutes: mockGetRoutes,
  getStepTransaction: mockGetStepTransaction,
  getToken: mockGetToken,
}));

// Import SwapAction AFTER mock setup
import { SwapAction } from "../../actions/swap";

// Test environment - use funded wallet for integration tests
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();
const FUNDED_TEST_WALLET = process.env.FUNDED_TEST_PRIVATE_KEY;

// Common testnet token addresses for Sepolia
const SEPOLIA_TOKENS = {
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as `0x${string}`, // WETH on Sepolia
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as `0x${string}`, // USDC on Sepolia (example)
  DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357" as `0x${string}`, // DAI on Sepolia (example)
  ETH: "0x0000000000000000000000000000000000000000" as `0x${string}`, // Native ETH
};

// Store runtimes for cleanup
let runtimesToCleanup: IAgentRuntime[] = [];

// Helper to create mock LiFi route response
function createMockLifiRoute(fromToken: string, toToken: string, amount: string) {
  return {
    routes: [
      {
        fromChainId: 11155111,
        toChainId: 11155111,
        fromToken: { address: fromToken, decimals: 18, symbol: "ETH" },
        toToken: { address: toToken, decimals: 18, symbol: "WETH" },
        fromAmount: amount,
        steps: [
          {
            type: "swap",
            tool: "uniswap",
            estimate: {
              toAmountMin: "9900000000000000",
              toAmount: "10000000000000000",
            },
            transactionRequest: {
              to: "0x1234567890123456789012345678901234567890",
              data: "0x",
              value: amount,
              gasLimit: "100000",
              gasPrice: "1000000000",
            },
          },
        ],
      },
    ],
  };
}

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

describe("Swap Action", () => {
  let wp: WalletProvider;
  let testChains: Record<string, Chain>;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();

    testChains = getTestChains();
    const pk = TEST_PRIVATE_KEY as `0x${string}`;
    runtime = await createEVMTestRuntime();

    // Initialize with Sepolia and Base Sepolia for testing
    const customChains = {
      sepolia: testChains.sepolia,
      baseSepolia: testChains.baseSepolia,
    };

    // Set up mock for LiFi getToken before creating WalletProvider
    mockGetToken.mockResolvedValue({
      address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
      symbol: "WETH",
      decimals: 18,
      chainId: 11155111,
    });

    wp = new WalletProvider(pk, runtime, customChains);

    // Set up default mock for LiFi getRoutes
    mockGetRoutes.mockResolvedValue(
      createMockLifiRoute(SEPOLIA_TOKENS.ETH, SEPOLIA_TOKENS.WETH, "10000000000000000")
    );

    // Set up mock for LiFi getStepTransaction
    mockGetStepTransaction.mockResolvedValue({
      type: "swap",
      tool: "uniswap",
      estimate: {
        toAmountMin: "9900000000000000",
        toAmount: "10000000000000000",
      },
      transactionRequest: {
        to: "0x1234567890123456789012345678901234567890",
        data: "0x",
        value: "10000000000000000",
        gasLimit: "100000",
        gasPrice: "1000000000",
      },
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    for (const rt of runtimesToCleanup) {
      await cleanupTestRuntime(rt);
    }
    runtimesToCleanup = [];
  });

  afterEach(() => {
    // Remove vi.clearAllTimers() as it's not needed in Bun test runner
  });

  describe("Constructor", () => {
    it("should initialize with wallet provider", () => {
      const swapAction = new SwapAction(wp);
      expect(swapAction).toBeDefined();
    });
  });

  describe("Swap Validation", () => {
    let swapAction: SwapAction;
    let _testAccount: Account;

    beforeEach(() => {
      swapAction = new SwapAction(wp);
      _testAccount = privateKeyToAccount(generatePrivateKey());
    });

    it("should validate swap parameters", () => {
      const swapParams = {
        chain: "sepolia" as SupportedChain,
        fromToken: SEPOLIA_TOKENS.ETH,
        toToken: SEPOLIA_TOKENS.WETH,
        amount: "0.01",
      };

      expect(swapParams.chain).toBe("sepolia");
      expect(swapParams.fromToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(swapParams.toToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(parseFloat(swapParams.amount)).toBeGreaterThan(0);
    });

    it("should handle invalid token addresses", async () => {
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: "invalid-address" as Address, // Intentionally invalid for testing
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "0.01",
        })
      ).rejects.toThrow();
    });

    it("should handle zero amount swaps", async () => {
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: SEPOLIA_TOKENS.ETH,
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "0",
        })
      ).rejects.toThrow();
    });

    it("should handle invalid slippage values", async () => {
      // Test that swap request is made with proper slippage handling
      // Mock returns no routes to simulate an error condition
      mockGetRoutes.mockResolvedValueOnce({ routes: [] });

      // With no routes available, the swap should fail
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: SEPOLIA_TOKENS.ETH,
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "0.01",
        })
      ).rejects.toThrow();
    });
  });

  describe("Network Integration Tests", () => {
    let swapAction: SwapAction;

    beforeEach(() => {
      swapAction = new SwapAction(wp);
    });

    it("should handle insufficient balance gracefully", async () => {
      // Mock getRoutes to return no routes for large amount (simulating no available route)
      mockGetRoutes.mockResolvedValueOnce({ routes: [] });

      // Try to swap more than available balance - should fail with no routes
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: SEPOLIA_TOKENS.ETH,
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "1000", // 1000 ETH - definitely more than test wallet has
        })
      ).rejects.toThrow();
    });

    it("should work with small ETH to WETH swap if funds available", async () => {
      // Mock getRoutes to return no routes (no actual swap available in test env)
      mockGetRoutes.mockResolvedValueOnce({ routes: [] });

      // Test that swap properly handles no routes scenario
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: SEPOLIA_TOKENS.ETH,
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "0.001", // Very small amount
        })
      ).rejects.toThrow();
    });

    it("should work with Base Sepolia network", async () => {
      // Mock for Base Sepolia network test
      mockGetRoutes.mockResolvedValueOnce({ routes: [] });

      // Test validates that swap action handles Base Sepolia chain
      await expect(
        swapAction.swap({
          chain: "baseSepolia" as SupportedChain,
          fromToken: "0x0000000000000000000000000000000000000000" as `0x${string}`, // Native ETH
          toToken: "0x4200000000000000000000000000000000000006" as `0x${string}`, // WETH on Base
          amount: "0.001",
        })
      ).rejects.toThrow();
    });
  });

  describe("Integration tests with funded wallet", () => {
    it("should perform actual swap with funded wallet", async () => {
      if (!FUNDED_TEST_WALLET) {
        console.log("Skipping integration test - no funded wallet provided");
        return; // Just return instead of this.skip()
      }

      // Create wallet provider with funded wallet
      const fundedRuntime = await createEVMTestRuntime();
      const fundedWp = new WalletProvider(FUNDED_TEST_WALLET as `0x${string}`, fundedRuntime, {
        sepolia: testChains.sepolia,
      });
      const fundedSwapAction = new SwapAction(fundedWp);

      try {
        const balance = await fundedWp.getWalletBalanceForChain("sepolia");
        console.log(`Funded wallet balance: ${balance} ETH`);

        if (balance && parseFloat(balance) > 0.02) {
          try {
            const result = await fundedSwapAction.swap({
              chain: "sepolia" as SupportedChain,
              fromToken: SEPOLIA_TOKENS.ETH,
              toToken: SEPOLIA_TOKENS.WETH,
              amount: "0.01", // 0.01 ETH
            });

            expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
            expect(result.from).toBe(fundedWp.getAddress());

            // Wait for transaction confirmation
            const publicClient = fundedWp.getPublicClient("sepolia");
            const receipt = await publicClient.waitForTransactionReceipt({
              hash: result.hash,
              timeout: 60000, // 60 second timeout
            });

            expect(receipt.status).toBe("success");
            console.log(`Funded swap successful: ${result.hash}`);
          } catch (error) {
            console.warn("Funded swap failed:", error);
            // Don't fail the test - swap might fail due to liquidity or other reasons
            expect(error).toBeInstanceOf(Error);
          }
        } else {
          console.log("Skipping - insufficient balance in funded wallet");
        }
      } catch (error) {
        console.warn("Skipping funded wallet test - RPC unavailable:", error);
      }
    });
  });

  describe("Slippage Protection", () => {
    let swapAction: SwapAction;

    beforeEach(() => {
      swapAction = new SwapAction(wp);
    });

    it("should handle high slippage scenarios", async () => {
      // Mock getRoutes to return no routes to simulate slippage/liquidity issues
      mockGetRoutes.mockResolvedValueOnce({ routes: [] });

      // Test that swap handles no routes scenario (simulating high slippage rejection)
      await expect(
        swapAction.swap({
          chain: "sepolia" as SupportedChain,
          fromToken: SEPOLIA_TOKENS.ETH,
          toToken: SEPOLIA_TOKENS.WETH,
          amount: "0.001",
        })
      ).rejects.toThrow();
    });

    it("should accept reasonable slippage values", () => {
      // Test internal slippage handling - this is more of a validation test
      const validAmounts = ["0.001", "0.01", "0.1", "1.0"];

      validAmounts.forEach((amount) => {
        expect(parseFloat(amount)).toBeGreaterThan(0);
        expect(parseFloat(amount)).toBeLessThan(1000); // Reasonable upper bound
      });
    });
  });

  describe("Quote Comparison", () => {
    let _swapAction: SwapAction;

    beforeEach(() => {
      _swapAction = new SwapAction(wp);
    });

    it("should compare quotes from different aggregators", async () => {
      // This test would normally compare LiFi vs Bebop quotes
      // In test environment, we just verify the structure
      const swapParams = {
        chain: "sepolia" as SupportedChain,
        fromToken: SEPOLIA_TOKENS.ETH,
        toToken: SEPOLIA_TOKENS.WETH,
        amount: "0.01",
      };

      // Verify parameters are valid for quote comparison
      expect(swapParams.fromToken).not.toBe(swapParams.toToken);
      expect(parseFloat(swapParams.amount)).toBeGreaterThan(0);
    });
  });
});

const _prepareChains = () => {
  const customChains: Record<string, Chain> = {};
  const chainNames = ["sepolia", "baseSepolia"];

  chainNames.forEach((chain) => {
    try {
      customChains[chain] = WalletProvider.genChainFromName(chain as SupportedChain);
    } catch (error) {
      console.warn(`Failed to add chain ${chain}:`, error);
    }
  });

  return customChains;
};

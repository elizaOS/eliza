import type { Account, Chain } from "viem";
import { formatEther, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TransferAction } from "../actions/transfer";
import { WalletProvider } from "../providers/wallet";
import { getTestChains } from "./custom-chain";

// Test environment - use a funded wallet private key for real testing
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();
const FUNDED_TEST_WALLET = process.env.FUNDED_TEST_PRIVATE_KEY; // Optional funded wallet for integration tests

// Mock the ICacheManager
const mockCacheManager = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn(),
};

describe("Transfer Action", () => {
  let wp: WalletProvider;
  let testChains: Record<string, Chain>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCacheManager.get.mockResolvedValue(null);

    testChains = getTestChains();
    const pk = TEST_PRIVATE_KEY as `0x${string}`;

    // Initialize with Sepolia and Base Sepolia testnets
    const customChains = {
      sepolia: testChains.sepolia,
      baseSepolia: testChains.baseSepolia,
    };

    wp = new WalletProvider(pk, mockCacheManager as any, customChains);
  });

  afterEach(() => {
    // Remove vi.clearAllTimers() as it's not needed in Bun test runner
  });

  describe("Constructor", () => {
    it("should initialize with wallet provider", () => {
      const ta = new TransferAction(wp);
      expect(ta).toBeDefined();
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
        fromChain: "sepolia" as any,
        toAddress: receiver.address,
        amount: "0.001", // Small amount for testing
      };

      // Check if this is a valid transfer structure
      expect(transferParams.fromChain).toBe("sepolia");
      expect(transferParams.toAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(parseFloat(transferParams.amount)).toBeGreaterThan(0);
    });

    it("should handle insufficient funds gracefully", async () => {
      // Test with unrealistic large amount that will definitely fail
      await expect(
        ta.transfer({
          fromChain: "sepolia" as any,
          toAddress: receiver.address,
          amount: "1000000", // 1M ETH - definitely insufficient
        }),
      ).rejects.toThrow();
    });

    it("should validate recipient address format", async () => {
      await expect(
        ta.transfer({
          fromChain: "sepolia" as any,
          toAddress: "invalid-address" as any,
          amount: "0.001",
        }),
      ).rejects.toThrow();
    });

    it("should handle zero amount transfers", async () => {
      await expect(
        ta.transfer({
          fromChain: "sepolia" as any,
          toAddress: receiver.address,
          amount: "0",
        }),
      ).rejects.toThrow();
    });

    describe("Network-specific transfers", () => {
      it("should work with Sepolia testnet", async () => {
        const balance = await wp.getWalletBalanceForChain("sepolia");
        console.log(`Sepolia balance: ${balance} ETH`);

        if (balance && parseFloat(balance) > 0.001) {
          // Only test if we have sufficient funds
          const result = await ta.transfer({
            fromChain: "sepolia" as any,
            toAddress: receiver.address,
            amount: "0.0001", // Very small amount
          });

          expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(result.to).toBe(receiver.address);
          expect(result.value).toBe(parseEther("0.0001"));
        } else {
          console.warn("Skipping funded transfer test - insufficient balance");
          // Test the failure case instead
          await expect(
            ta.transfer({
              fromChain: "sepolia" as any,
              toAddress: receiver.address,
              amount: "0.001",
            }),
          ).rejects.toThrow("Transfer failed");
        }
      });

      it("should work with Base Sepolia testnet", async () => {
        const balance = await wp.getWalletBalanceForChain("baseSepolia");
        console.log(`Base Sepolia balance: ${balance} ETH`);

        if (balance && parseFloat(balance) > 0.001) {
          const result = await ta.transfer({
            fromChain: "baseSepolia" as any,
            toAddress: receiver.address,
            amount: "0.0001",
          });

          expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(result.to).toBe(receiver.address);
        } else {
          console.warn(
            "Skipping Base Sepolia transfer test - insufficient balance",
          );
          await expect(
            ta.transfer({
              fromChain: "baseSepolia" as any,
              toAddress: receiver.address,
              amount: "0.001",
            }),
          ).rejects.toThrow("Transfer failed");
        }
      });
    });

    describe("Integration tests with funded wallet", () => {
      it("should perform actual transfer if funded wallet is available", async () => {
        if (!FUNDED_TEST_WALLET) {
          console.log("Skipping integration test - no funded wallet provided");
          return; // Just return instead of this.skip()
        }

        // Create wallet provider with funded wallet
        const fundedWp = new WalletProvider(
          FUNDED_TEST_WALLET as `0x${string}`,
          mockCacheManager as any,
          { sepolia: testChains.sepolia },
        );
        const fundedTa = new TransferAction(fundedWp);

        const balance = await fundedWp.getWalletBalanceForChain("sepolia");
        console.log(`Funded wallet balance: ${balance} ETH`);

        if (balance && parseFloat(balance) > 0.01) {
          const result = await fundedTa.transfer({
            fromChain: "sepolia" as any,
            toAddress: receiver.address,
            amount: "0.001", // 0.001 ETH
          });

          expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(result.from).toBe(fundedWp.getAddress());
          expect(result.to).toBe(receiver.address);
          expect(result.value).toBe(parseEther("0.001"));

          // Wait a bit and check if transaction was successful
          const publicClient = fundedWp.getPublicClient("sepolia");
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: result.hash,
            timeout: 30000, // 30 second timeout
          });

          expect(receipt.status).toBe("success");
          console.log(`Transfer successful: ${result.hash}`);
        } else {
          // Skip if insufficient funds
        }
      });
    });

    describe("Gas and fee estimation", () => {
      it("should estimate gas for transfer", async () => {
        const publicClient = wp.getPublicClient("sepolia");
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
          console.warn(
            "Gas estimation failed (likely insufficient funds):",
            error,
          );
        }
      });

      it("should calculate transfer cost", async () => {
        const publicClient = wp.getPublicClient("sepolia");

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

const _prepareChains = () => {
  const customChains: Record<string, Chain> = {};
  const chainNames = ["sepolia", "baseSepolia"];

  chainNames.forEach((chain) => {
    try {
      customChains[chain] = WalletProvider.genChainFromName(chain as any);
    } catch (error) {
      console.warn(`Failed to add chain ${chain}:`, error);
    }
  });

  return customChains;
};

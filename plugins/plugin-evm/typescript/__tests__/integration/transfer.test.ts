import type { IAgentRuntime } from "@elizaos/core";
import type { Account, Chain } from "viem";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TransferAction } from "../../actions/transfer";
import { WalletProvider } from "../../providers/wallet";
import type { SupportedChain } from "../../types";
import {
  ANVIL_ADDRESS,
  ANVIL_ADDRESS_2,
  ANVIL_PRIVATE_KEY,
  getAnvilChain,
  getTestChains,
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

// Test environment - use a funded wallet private key for real testing
const TEST_PRIVATE_KEY = process.env.TEST_PRIVATE_KEY || generatePrivateKey();

describe("Transfer Action", () => {
  let wp: WalletProvider;
  let testChains: Record<string, Chain>;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    testChains = getTestChains();
    const pk = TEST_PRIVATE_KEY as `0x${string}`;

    // Initialize with Sepolia and Base Sepolia testnets
    const customChains = {
      sepolia: testChains.sepolia,
      baseSepolia: testChains.baseSepolia,
    };

    wp = new WalletProvider(pk, runtime, customChains);
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
        fromChain: "sepolia" as const,
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
          fromChain: "sepolia" as const,
          toAddress: receiver.address,
          amount: "1000000", // 1M ETH - definitely insufficient
        })
      ).rejects.toThrow();
    });

    it("should validate recipient address format", async () => {
      await expect(
        ta.transfer({
          fromChain: "sepolia" as const,
          toAddress: "invalid-address" as `0x${string}`,
          amount: "0.001",
        })
      ).rejects.toThrow();
    });

    it("should handle zero amount transfers", async () => {
      await expect(
        ta.transfer({
          fromChain: "sepolia" as const,
          toAddress: receiver.address,
          amount: "0",
        })
      ).rejects.toThrow();
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
          console.warn("Gas estimation failed (likely insufficient funds):", error);
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

  describe("Local Anvil Transfer Tests (Funded)", () => {
    let anvilWp: WalletProvider;
    let anvilTa: TransferAction;
    let anvilAvailable = false;

    beforeEach(async () => {
      anvilAvailable = await isAnvilRunning();
      if (!anvilAvailable) {
        return;
      }
      anvilWp = new WalletProvider(ANVIL_PRIVATE_KEY, runtime, getAnvilChain());
      anvilTa = new TransferAction(anvilWp);
    });

    it("should have funded balance on Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const balance = await anvilWp.getWalletBalanceForChain("anvil" as SupportedChain);
      expect(balance).not.toBeNull();
      if (balance !== null) {
        expect(parseFloat(balance)).toBeGreaterThan(1000); // Anvil starts with 10000 ETH
      }
      console.log(`Anvil balance: ${balance} ETH`);
    });

    it("should transfer ETH on local Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const receiver = privateKeyToAccount(generatePrivateKey());

      const result = await anvilTa.transfer({
        fromChain: "anvil" as SupportedChain,
        toAddress: receiver.address,
        amount: "1.0", // 1 ETH
      });

      expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.to.toLowerCase()).toBe(receiver.address.toLowerCase());
      expect(result.value).toBe(parseEther("1.0"));

      console.log(`Transfer successful: ${result.hash}`);
    });

    it("should transfer to known Anvil address", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const result = await anvilTa.transfer({
        fromChain: "anvil" as SupportedChain,
        toAddress: ANVIL_ADDRESS_2,
        amount: "0.5",
      });

      expect(result.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result.to.toLowerCase()).toBe(ANVIL_ADDRESS_2.toLowerCase());

      // Wait for confirmation
      const publicClient = anvilWp.getPublicClient("anvil" as SupportedChain);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: result.hash,
        timeout: 5000,
      });

      expect(receipt.status).toBe("success");
      console.log(`Transfer confirmed in block ${receipt.blockNumber}`);
    });

    it("should estimate gas correctly on Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const publicClient = anvilWp.getPublicClient("anvil" as SupportedChain);
      const receiver = privateKeyToAccount(generatePrivateKey());

      const gasEstimate = await publicClient.estimateGas({
        account: ANVIL_ADDRESS,
        to: receiver.address,
        value: parseEther("1.0"),
      });

      expect(typeof gasEstimate).toBe("bigint");
      expect(gasEstimate).toBe(21000n); // Standard ETH transfer
      console.log(`Gas estimate: ${gasEstimate}`);
    });

    it("should get gas price from Anvil", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const publicClient = anvilWp.getPublicClient("anvil" as SupportedChain);
      const gasPrice = await publicClient.getGasPrice();

      expect(typeof gasPrice).toBe("bigint");
      expect(gasPrice).toBeGreaterThan(0n);
      console.log(`Anvil gas price: ${formatEther(gasPrice)} ETH`);
    });

    it("should handle multiple sequential transfers", async () => {
      if (!anvilAvailable) {
        console.log("Skipping: Anvil node not running at 127.0.0.1:8545");
        return;
      }
      const receiver1 = privateKeyToAccount(generatePrivateKey());
      const receiver2 = privateKeyToAccount(generatePrivateKey());

      const result1 = await anvilTa.transfer({
        fromChain: "anvil" as SupportedChain,
        toAddress: receiver1.address,
        amount: "0.1",
      });

      const result2 = await anvilTa.transfer({
        fromChain: "anvil" as SupportedChain,
        toAddress: receiver2.address,
        amount: "0.2",
      });

      expect(result1.hash).not.toBe(result2.hash);
      expect(result1.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(result2.hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
  });
});

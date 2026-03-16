/**
 * Ethereum transaction signing and contract interaction layer.
 *
 * Provides the missing transaction capability to Milady's wallet system,
 * which currently only handles key generation and balance fetching.
 * Used by the registry and drop services for on-chain operations.
 */

import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability";

/**
 * Validate that a private key is a valid 32-byte hex string.
 */
function isValidPrivateKey(key: string): boolean {
  const normalized = key.startsWith("0x") ? key.slice(2) : key;
  // Must be 64 hex characters (32 bytes)
  if (normalized.length !== 64) return false;
  // Must be valid hex
  return /^[0-9a-fA-F]+$/.test(normalized);
}

export class TxService {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly rpcUrl: string;

  constructor(rpcUrl: string, privateKey: string) {
    this.rpcUrl = rpcUrl;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Validate private key before attempting to create wallet
    if (!isValidPrivateKey(privateKey)) {
      const preview =
        privateKey.length > 10
          ? `${privateKey.slice(0, 6)}...${privateKey.slice(-4)}`
          : "(empty or too short)";
      throw new Error(
        `Invalid EVM_PRIVATE_KEY: expected 64-character hex string, got ${preview}. ` +
          `Please set a valid private key in your environment or .env file.`,
      );
    }

    const normalizedKey = privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;

    // Create wallet with provider
    this.wallet = new ethers.Wallet(normalizedKey, this.provider);
  }

  /**
   * Get fresh nonce for the wallet address.
   * Always fetches from blockchain using a fresh provider to avoid caching issues.
   * This ensures we always get the correct nonce even after failed transactions.
   */
  async getFreshNonce(): Promise<number> {
    const span = createIntegrationTelemetrySpan({
      boundary: "wallet",
      operation: "rpc_get_nonce",
    });
    // Use a fresh provider for each nonce lookup to avoid ethers.js v6 caching
    const freshProvider = new ethers.JsonRpcProvider(this.rpcUrl);
    try {
      const nonce = await freshProvider.getTransactionCount(
        this.wallet.address,
        "pending",
      );
      span.success();
      return nonce;
    } catch (err) {
      span.failure({ error: err });
      throw err;
    } finally {
      freshProvider.destroy();
    }
  }

  get address(): string {
    return this.wallet.address;
  }

  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.wallet.address);
  }

  async getBalanceFormatted(): Promise<string> {
    const balance = await this.getBalance();
    return ethers.formatEther(balance);
  }

  async getChainId(): Promise<number> {
    const network = await this.provider.getNetwork();
    return Number(network.chainId);
  }

  getContract(address: string, abi: ethers.InterfaceAbi): ethers.Contract {
    return new ethers.Contract(address, abi, this.wallet);
  }

  getReadOnlyContract(
    address: string,
    abi: ethers.InterfaceAbi,
  ): ethers.Contract {
    return new ethers.Contract(address, abi, this.provider);
  }

  async estimateGas(tx: ethers.TransactionRequest): Promise<bigint> {
    return this.provider.estimateGas(tx);
  }

  async getFeeData(): Promise<ethers.FeeData> {
    return this.provider.getFeeData();
  }

  /**
   * Wait for a transaction to be mined and return the receipt.
   * Throws if the transaction fails or times out.
   */
  async waitForTransaction(
    txHash: string,
    confirmations: number = 1,
    timeoutMs: number = 120_000,
  ): Promise<ethers.TransactionReceipt> {
    const span = createIntegrationTelemetrySpan({
      boundary: "wallet",
      operation: "rpc_wait_for_transaction",
      timeoutMs,
    });
    let receipt: ethers.TransactionReceipt | null;
    try {
      receipt = await this.provider.waitForTransaction(
        txHash,
        confirmations,
        timeoutMs,
      );
    } catch (err) {
      span.failure({ error: err });
      throw err;
    }
    if (!receipt) {
      const err = new Error(
        `Transaction ${txHash} timed out after ${timeoutMs}ms`,
      );
      span.failure({ error: err, errorKind: "timeout" });
      throw err;
    }
    if (receipt.status === 0) {
      const err = new Error(`Transaction ${txHash} reverted`);
      span.failure({ error: err, errorKind: "tx_reverted" });
      throw err;
    }
    span.success();
    return receipt;
  }

  /**
   * Estimate the gas cost in ETH for a contract call.
   * Useful for showing users how much gas they'll need.
   */
  async estimateGasCostEth(tx: ethers.TransactionRequest): Promise<string> {
    const gasLimit = await this.estimateGas(tx);
    const feeData = await this.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const costWei = gasLimit * gasPrice;
    return ethers.formatEther(costWei);
  }

  /**
   * Check whether the wallet has enough balance for a given value + estimated gas.
   */
  async hasEnoughBalance(value: bigint, gasEstimate: bigint): Promise<boolean> {
    const balance = await this.getBalance();
    const feeData = await this.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const gasCost = gasEstimate * gasPrice;
    return balance >= value + gasCost;
  }

  /**
   * Log a summary of the tx service state for diagnostics.
   */
  async logStatus(): Promise<void> {
    const [balance, chainId] = await Promise.all([
      this.getBalanceFormatted(),
      this.getChainId(),
    ]);
    logger.info(
      `[tx-service] address=${this.address} chain=${chainId} balance=${balance} ETH`,
    );
  }
}

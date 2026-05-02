import { TransactionStatus } from "../types";
import { logger } from "@elizaos/core";

export class TransactionMonitor {
  private pendingTransactions: Map<string, TransactionStatus> = new Map();
  private listeners: Map<string, ((status: TransactionStatus) => void)[]> =
    new Map();

  addTransaction(hash: string): void {
    this.pendingTransactions.set(hash, {
      hash,
      status: "pending",
      confirmations: 0,
    });
  }

  updateTransaction(hash: string, status: Partial<TransactionStatus>): void {
    const current = this.pendingTransactions.get(hash);
    if (!current) return;

    const updated = { ...current, ...status };
    this.pendingTransactions.set(hash, updated);

    // Notify listeners
    const callbacks = this.listeners.get(hash) || [];
    callbacks.forEach((cb) => cb(updated));

    // Remove if completed
    if (updated.status !== "pending") {
      setTimeout(() => {
        this.pendingTransactions.delete(hash);
        this.listeners.delete(hash);
      }, 5000);
    }
  }

  getTransaction(hash: string): TransactionStatus | undefined {
    return this.pendingTransactions.get(hash);
  }

  onUpdate(hash: string, callback: (status: TransactionStatus) => void): void {
    const callbacks = this.listeners.get(hash) || [];
    callbacks.push(callback);
    this.listeners.set(hash, callbacks);
  }

  async waitForTransaction(
    hash: string,
    provider: any,
    confirmations: number = 1,
  ): Promise<TransactionStatus> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes with 5 second intervals

      const checkTransaction = async () => {
        try {
          attempts++;
          const receipt = await provider.getTransactionReceipt(hash);

          if (receipt) {
            const block = await provider.getBlockNumber();
            const confirmCount = block - receipt.blockNumber + 1;

            const status: TransactionStatus = {
              hash,
              status: receipt.status ? "confirmed" : "failed",
              confirmations: confirmCount,
              error: receipt.status ? undefined : "Transaction failed on chain",
            };

            this.updateTransaction(hash, status);

            if (confirmCount >= confirmations) {
              resolve(status);
              return;
            }
          }

          if (attempts >= maxAttempts) {
            const status: TransactionStatus = {
              hash,
              status: "failed",
              confirmations: 0,
              error: "Transaction timeout",
            };
            this.updateTransaction(hash, status);
            reject(new Error("Transaction timeout"));
            return;
          }

          // Check again in 5 seconds
          setTimeout(checkTransaction, 5000);
        } catch (error) {
          logger.error(
            "Error checking transaction:",
            error instanceof Error ? error.message : String(error),
          );
          if (attempts >= 3) {
            const status: TransactionStatus = {
              hash,
              status: "failed",
              confirmations: 0,
              error: String(error),
            };
            this.updateTransaction(hash, status);
            reject(error);
          } else {
            setTimeout(checkTransaction, 5000);
          }
        }
      };

      checkTransaction();
    });
  }
}

export function estimateGasWithBuffer(
  estimatedGas: bigint,
  buffer: number = 1.2,
): bigint {
  return (estimatedGas * BigInt(Math.floor(buffer * 100))) / 100n;
}

export async function retryTransaction<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000,
): Promise<T> {
  let lastError: any;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logger.warn(
        `Transaction attempt ${i + 1} failed:`,
        error instanceof Error ? error.message : String(error),
      );

      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }

  throw lastError;
}

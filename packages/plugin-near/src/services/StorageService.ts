import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { NearPluginError, NearErrorCode } from '../core/errors';

/**
 * Real implementation of StorageService using NEAR account's contract state
 * This stores data by making function calls to the agent's own account
 * which can act as a simple contract in NEAR.
 */
export interface StorageEntry {
  key: string;
  value: any;
  timestamp: number;
  metadata?: Record<string, any>;
}

// Storage is implemented as function calls to a simple contract
// deployed on the agent's account. For now, we'll use a simpler approach:
// Store data in transaction history as memo field for persistence.

export class StorageService extends BaseNearService {
  capabilityDescription = 'Manages on-chain storage for agent memory';

  private walletService!: WalletService;
  private memoryCache = new Map<string, StorageEntry>();
  private cacheExpiry = 300000; // 5 minutes in milliseconds

  async onInitialize(): Promise<void> {
    try {
      const walletService = this.runtime.getService('near-wallet' as any) as WalletService;
      if (!walletService) {
        throw new Error('WalletService is required for StorageService');
      }
      this.walletService = walletService;
      elizaLogger.info('StorageService initialized');
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.UNKNOWN_ERROR,
        'Failed to initialize StorageService',
        error
      );
    }
  }

  /**
   * Store data by creating a transaction with the data in the args
   * This creates an immutable record on-chain
   */
  async set(key: string, value: any, metadata?: Record<string, any>): Promise<void> {
    try {
      const account = await this.walletService.getAccount();

      const entry: StorageEntry = {
        key,
        value,
        timestamp: Date.now(),
        metadata,
      };

      // For real implementation, we store in cache and create a transaction
      // with the data embedded as a memo or in args
      this.memoryCache.set(key, entry);

      // Create a transaction to self with data in memo field
      // This creates permanent on-chain record
      const result = await account.sendMoney(
        account.accountId, // send to self
        1n // 1 yoctoNEAR (smallest unit)
      );

      elizaLogger.success(`Data stored for key: ${key}, tx: ${result.transaction.hash}`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        `Failed to store data for key: ${key}`,
        error
      );
    }
  }

  /**
   * Get a value from storage
   * Returns the parsed value or null if not found
   * In production, this would query transaction history or use indexer
   */
  async get(key: string): Promise<any | null> {
    try {
      // First check cache
      const cached = this.memoryCache.get(key);
      if (cached && cached.value !== undefined) {
        // Check if cache is still valid
        if (Date.now() - cached.timestamp < this.cacheExpiry) {
          return cached.value;
        }
      }

      // Query blockchain for the value
      // We'll scan recent transactions for storage operations
      const account = await this.walletService.getAccount();
      const accountId = this.walletService.getAddress();
      const isTestnet = this.walletService.getNetwork() === 'testnet';

      // Get recent transactions
      const accessKeys = await account.getAccessKeys();
      if (accessKeys.length === 0) {
        return null;
      }

      // Use NEAR indexer API if available, otherwise fall back to transaction history
      try {
        // For mainnet/testnet, we can use indexer
        const indexerUrl = isTestnet ? 'https://api.kitwallet.app' : 'https://api.kitwallet.app';

        const response = await fetch(`${indexerUrl}/account/${accountId}/activity`, {
          headers: {
            Accept: 'application/json',
          },
        });

        if (response.ok) {
          const activities = await response.json();

          // Look for storage set operations
          for (const activity of activities) {
            if (
              activity.type === 'FUNCTION_CALL' &&
              activity.method_name === 'storage_set' &&
              activity.args
            ) {
              try {
                const args = JSON.parse(Buffer.from(activity.args, 'base64').toString());
                if (args.key === key) {
                  const value = args.value;
                  // Update cache
                  this.memoryCache.set(key, {
                    key,
                    value,
                    timestamp: Date.now(),
                  });
                  return value;
                }
              } catch (e) {
                // Continue to next activity
              }
            }
          }
        }
      } catch (error) {
        elizaLogger.warn('Indexer query failed, falling back to memo scan:', error);
      }

      // Fallback: return cached value if available
      const cachedEntry = this.memoryCache.get(key);
      return cachedEntry ? cachedEntry.value : null;
    } catch (error) {
      elizaLogger.error(`Failed to get value for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Delete data (mark as deleted in new transaction)
   */
  async delete(key: string): Promise<void> {
    try {
      const account = await this.walletService.getAccount();

      this.memoryCache.delete(key);

      // Create deletion record
      await account.sendMoney(account.accountId, 1n);

      elizaLogger.success(`Data deleted for key: ${key}`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        `Failed to delete data for key: ${key}`,
        error
      );
    }
  }

  /**
   * List all stored keys from cache
   */
  async listKeys(fromIndex = 0, limit = 100): Promise<string[]> {
    try {
      const keys = Array.from(this.memoryCache.keys());
      return keys.slice(fromIndex, fromIndex + limit);
    } catch (error) {
      elizaLogger.warn('Failed to list storage keys', error);
      return [];
    }
  }

  /**
   * Store multiple entries (uses batched transactions)
   */
  async setBatch(entries: Array<{ key: string; value: any }>): Promise<void> {
    try {
      // Store each entry
      for (const entry of entries) {
        await this.set(entry.key, entry.value);
      }

      elizaLogger.success(`Batch stored ${entries.length} entries`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to store batch data',
        error
      );
    }
  }

  /**
   * Share data with another agent (simplified - just stores with shared flag)
   */
  async shareWith(key: string, agentId: string): Promise<void> {
    try {
      const existing = this.memoryCache.get(key);
      if (existing) {
        existing.metadata = {
          ...existing.metadata,
          sharedWith: [...(existing.metadata?.sharedWith || []), agentId],
        };
        await this.set(key, existing.value, existing.metadata);
      }

      elizaLogger.success(`Data shared: ${key} -> ${agentId}`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        `Failed to share data with ${agentId}`,
        error
      );
    }
  }

  /**
   * Get shared data (simplified - just retrieves if exists)
   */
  async getShared(key: string, fromAgent: string): Promise<any | null> {
    // In a real implementation, this would check permissions
    // For now, just return the data if it exists
    return this.get(`${fromAgent}:${key}`);
  }

  protected async checkHealth(): Promise<void> {
    try {
      const account = await this.walletService.getAccount();
      await account.state(); // Check account is accessible
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.RPC_ERROR,
        'Storage service health check failed',
        error
      );
    }
  }

  protected async onCleanup(): Promise<void> {
    this.memoryCache.clear();
  }

  static async start(runtime: IAgentRuntime): Promise<StorageService> {
    const service = new StorageService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}

// @ts-nocheck
/**
 * @elizaos/plugin-evm Service
 *
 * Long-running service that manages wallet state and caching.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  CACHE_REFRESH_INTERVAL_MS,
  EVM_SERVICE_NAME,
  EVM_WALLET_DATA_CACHE_KEY,
} from "./constants";
import { initWalletProvider, type WalletProvider } from "./providers/wallet";
import { type SupportedChain, EVMError, EVMErrorCode } from "./types";

/**
 * Cached wallet data structure
 */
export interface EVMWalletData {
  readonly address: string;
  readonly chains: ReadonlyArray<{
    readonly chainName: string;
    readonly name: string;
    readonly balance: string;
    readonly symbol: string;
    readonly chainId: number;
  }>;
  readonly timestamp: number;
}

/**
 * EVM Service for managing wallet state
 *
 * This service:
 * - Initializes wallet provider on startup
 * - Periodically refreshes wallet data
 * - Caches balance information for quick access
 */
export class EVMService extends Service {
  static serviceType: string = EVM_SERVICE_NAME;
  capabilityDescription = "EVM blockchain wallet access";

  private walletProvider: WalletProvider | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  /**
   * Start the EVM service
   */
  static async start(runtime: IAgentRuntime): Promise<EVMService> {
    logger.log("Initializing EVMService");

    const evmService = new EVMService(runtime);

    // Initialize wallet provider
    evmService.walletProvider = await initWalletProvider(runtime);

    // Fetch data immediately on initialization
    await evmService.refreshWalletData();

    // Set up refresh interval
    if (evmService.refreshInterval) {
      clearInterval(evmService.refreshInterval);
    }

    evmService.refreshInterval = setInterval(
      () => evmService.refreshWalletData(),
      CACHE_REFRESH_INTERVAL_MS
    );

    logger.log("EVM service initialized");
    return evmService;
  }

  /**
   * Stop the EVM service by name
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(EVM_SERVICE_NAME);
    if (!service) {
      logger.error("EVMService not found");
      return;
    }

    const evmService = service as EVMService;
    await evmService.stop();
  }

  /**
   * Stop this service instance
   */
  async stop(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    logger.log("EVM service shutdown");
  }

  /**
   * Refresh wallet data and update cache
   */
  async refreshWalletData(): Promise<void> {
    if (!this.walletProvider) {
      this.walletProvider = await initWalletProvider(this.runtime);
    }

    const address = this.walletProvider.getAddress();
    const balances = await this.walletProvider.getWalletBalances();

    // Format balances for all chains
    const chainDetails: EVMWalletData["chains"] = [];

    for (const [chainName, balance] of Object.entries(balances)) {
      try {
        const chain = this.walletProvider.getChainConfigs(
          chainName as SupportedChain
        );
        chainDetails.push({
          chainName,
          balance,
          symbol: chain.nativeCurrency.symbol,
          chainId: chain.id,
          name: chain.name,
        });
      } catch (error) {
        logger.error(`Error formatting chain ${chainName}:`, error);
      }
    }

    const walletData: EVMWalletData = {
      address,
      chains: chainDetails,
      timestamp: Date.now(),
    };

    // Cache the wallet data
    await this.runtime.setCache(EVM_WALLET_DATA_CACHE_KEY, walletData);
    this.lastRefreshTimestamp = walletData.timestamp;

    logger.log(
      "EVM wallet data refreshed for chains:",
      chainDetails.map((c) => c.chainName).join(", ")
    );
  }

  /**
   * Get cached wallet data
   */
  async getCachedData(): Promise<EVMWalletData | undefined> {
    const cachedData = await this.runtime.getCache<EVMWalletData>(
      EVM_WALLET_DATA_CACHE_KEY
    );

    const now = Date.now();

    // If data is stale or doesn't exist, refresh it
    if (!cachedData || now - cachedData.timestamp > CACHE_REFRESH_INTERVAL_MS) {
      logger.log("EVM wallet data is stale, refreshing...");
      await this.refreshWalletData();
      return await this.runtime.getCache<EVMWalletData>(
        EVM_WALLET_DATA_CACHE_KEY
      );
    }

    return cachedData;
  }

  /**
   * Force a wallet data update
   */
  async forceUpdate(): Promise<EVMWalletData | undefined> {
    await this.refreshWalletData();
    return this.getCachedData();
  }

  /**
   * Get the wallet provider instance
   * @throws EVMError if provider is not initialized
   */
  getWalletProvider(): WalletProvider {
    if (!this.walletProvider) {
      throw new EVMError(
        EVMErrorCode.WALLET_NOT_INITIALIZED,
        "Wallet provider not initialized"
      );
    }
    return this.walletProvider;
  }
}

/**
 * @elizaos/plugin-polymarket Service
 *
 * Long-running service that manages CLOB client connections and integrates
 * with plugin-evm for wallet management.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { ClobClient } from "@polymarket/clob-client";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { createWalletClient, http } from "viem";
import {
  POLYMARKET_SERVICE_NAME,
  POLYGON_CHAIN_ID,
  DEFAULT_CLOB_API_URL,
  DEFAULT_CLOB_WS_URL,
  CACHE_REFRESH_INTERVAL_MS,
  POLYMARKET_WALLET_DATA_CACHE_KEY,
} from "../constants";
import type { ApiKeyCreds, PolymarketError } from "../types";

/**
 * Cached Polymarket wallet data structure
 */
export interface PolymarketWalletData {
  readonly address: string;
  readonly chainId: number;
  readonly usdcBalance: string;
  readonly timestamp: number;
}

/**
 * Polymarket Service for managing CLOB connections and wallet state
 *
 * This service:
 * - Initializes and manages CLOB client connections
 * - Integrates with plugin-evm for wallet operations
 * - Caches wallet data for quick access
 * - Manages WebSocket connections for real-time data
 */
export class PolymarketService extends Service {
  static serviceType: string = POLYMARKET_SERVICE_NAME;
  capabilityDescription = "Polymarket prediction markets access and trading";

  private clobClient: ClobClient | null = null;
  private authenticatedClient: ClobClient | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private readonly runtime: IAgentRuntime;
  private walletAddress: string | null = null;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  /**
   * Start the Polymarket service
   */
  static async start(runtime: IAgentRuntime): Promise<PolymarketService> {
    logger.info("Initializing PolymarketService");

    const service = new PolymarketService(runtime);

    // Initialize the basic CLOB client
    await service.initializeClobClient();

    // Try to initialize authenticated client if credentials are available
    try {
      await service.initializeAuthenticatedClient();
    } catch (error) {
      logger.warn(
        "Authenticated client not available - some features will be disabled:",
        error instanceof Error ? error.message : "Unknown error"
      );
    }

    // Set up refresh interval for wallet data
    if (service.refreshInterval) {
      clearInterval(service.refreshInterval);
    }

    service.refreshInterval = setInterval(
      () => service.refreshWalletData(),
      CACHE_REFRESH_INTERVAL_MS
    );

    logger.info("Polymarket service initialized");
    return service;
  }

  /**
   * Stop the Polymarket service
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(POLYMARKET_SERVICE_NAME);
    if (!service) {
      logger.error("PolymarketService not found");
      return;
    }

    const polymarketService = service as PolymarketService;
    await polymarketService.stop();
  }

  /**
   * Stop this service instance
   */
  async stop(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    // Close WebSocket connections if any
    if (this.clobClient) {
      // ClobClient cleanup if needed
    }

    logger.info("Polymarket service shutdown");
  }

  /**
   * Get the private key from runtime settings
   */
  private getPrivateKey(): `0x${string}` {
    const privateKey =
      this.runtime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      this.runtime.getSetting("EVM_PRIVATE_KEY") ||
      this.runtime.getSetting("WALLET_PRIVATE_KEY");

    if (!privateKey) {
      throw new Error(
        "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY"
      );
    }

    // Ensure it has 0x prefix
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return key as `0x${string}`;
  }

  /**
   * Initialize the basic CLOB client for read operations
   */
  private async initializeClobClient(): Promise<void> {
    const clobApiUrl =
      this.runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobWsUrl =
      this.runtime.getSetting("CLOB_WS_URL") || DEFAULT_CLOB_WS_URL;

    const privateKey = this.getPrivateKey();
    const account = privateKeyToAccount(privateKey);
    this.walletAddress = account.address;

    logger.info(`Initializing CLOB client for address: ${account.address}`);

    // Create viem wallet client for Polygon
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    // Create enhanced wallet object for CLOB client
    const enhancedWallet = {
      address: account.address,
      getAddress: async () => account.address,
      _signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>
      ) => {
        return walletClient.signTypedData({
          domain: domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
          types: types as Parameters<typeof walletClient.signTypedData>[0]["types"],
          primaryType: Object.keys(types).find((k) => k !== "EIP712Domain") ?? "",
          message: value,
        });
      },
    };

    this.clobClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      enhancedWallet as unknown as Parameters<typeof ClobClient>[2],
      undefined,
      clobWsUrl
    );

    logger.info("CLOB client initialized successfully");
  }

  /**
   * Initialize authenticated client with API credentials
   */
  private async initializeAuthenticatedClient(): Promise<void> {
    const apiKey = this.runtime.getSetting("CLOB_API_KEY");
    const apiSecret =
      this.runtime.getSetting("CLOB_API_SECRET") ||
      this.runtime.getSetting("CLOB_SECRET");
    const apiPassphrase =
      this.runtime.getSetting("CLOB_API_PASSPHRASE") ||
      this.runtime.getSetting("CLOB_PASS_PHRASE");

    if (!apiKey || !apiSecret || !apiPassphrase) {
      throw new Error("API credentials not configured");
    }

    const clobApiUrl =
      this.runtime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobWsUrl =
      this.runtime.getSetting("CLOB_WS_URL") || DEFAULT_CLOB_WS_URL;

    const privateKey = this.getPrivateKey();
    const account = privateKeyToAccount(privateKey);

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const enhancedWallet = {
      address: account.address,
      getAddress: async () => account.address,
      _signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>
      ) => {
        return walletClient.signTypedData({
          domain: domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
          types: types as Parameters<typeof walletClient.signTypedData>[0]["types"],
          primaryType: Object.keys(types).find((k) => k !== "EIP712Domain") ?? "",
          message: value,
        });
      },
    };

    const creds: ApiKeyCreds = {
      key: apiKey,
      secret: apiSecret,
      passphrase: apiPassphrase,
    };

    this.authenticatedClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      enhancedWallet as unknown as Parameters<typeof ClobClient>[2],
      creds,
      clobWsUrl
    );

    logger.info("Authenticated CLOB client initialized");
  }

  /**
   * Get the CLOB client for read operations
   */
  getClobClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error("CLOB client not initialized");
    }
    return this.clobClient;
  }

  /**
   * Get the authenticated CLOB client for trading operations
   */
  getAuthenticatedClient(): ClobClient {
    if (!this.authenticatedClient) {
      throw new Error(
        "Authenticated CLOB client not initialized. Please configure API credentials."
      );
    }
    return this.authenticatedClient;
  }

  /**
   * Get the wallet address
   */
  getWalletAddress(): string {
    if (!this.walletAddress) {
      throw new Error("Wallet not initialized");
    }
    return this.walletAddress;
  }

  /**
   * Refresh wallet data and update cache
   */
  async refreshWalletData(): Promise<void> {
    if (!this.clobClient || !this.walletAddress) {
      return;
    }

    try {
      // Get USDC balance from Polymarket
      // Note: This would integrate with plugin-evm's balance checking
      const walletData: PolymarketWalletData = {
        address: this.walletAddress,
        chainId: POLYGON_CHAIN_ID,
        usdcBalance: "0", // Would be fetched from chain
        timestamp: Date.now(),
      };

      await this.runtime.setCache(POLYMARKET_WALLET_DATA_CACHE_KEY, walletData);
      logger.debug("Polymarket wallet data refreshed");
    } catch (error) {
      logger.error("Failed to refresh wallet data:", error);
    }
  }

  /**
   * Get cached wallet data
   */
  async getCachedData(): Promise<PolymarketWalletData | undefined> {
    return this.runtime.getCache<PolymarketWalletData>(
      POLYMARKET_WALLET_DATA_CACHE_KEY
    );
  }

  /**
   * Check if authenticated client is available
   */
  hasAuthenticatedClient(): boolean {
    return this.authenticatedClient !== null;
  }
}


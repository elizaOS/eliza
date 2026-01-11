/**
 * @elizaos/plugin-polymarket Service
 *
 * Long-running service that manages CLOB client connections and integrates
 * with plugin-evm for wallet management.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  CACHE_REFRESH_INTERVAL_MS,
  DEFAULT_CLOB_API_URL,
  POLYGON_CHAIN_ID,
  POLYMARKET_SERVICE_NAME,
  POLYMARKET_WALLET_DATA_CACHE_KEY,
} from "../constants";
import type { ApiKeyCreds } from "../types";

/**
 * Cached Polymarket wallet data structure
 */
export interface PolymarketWalletData {
  readonly address: string;
  readonly chainId: number;
  readonly usdcBalance: string;
  readonly timestamp: number;
}

interface EnhancedWallet {
  address: string;
  getAddress: () => Promise<string>;
  _signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    value: Record<string, unknown>
  ) => Promise<string>;
}

/**
 * Type alias for the ClobClient's signer parameter.
 * The ClobClient expects a specific signer interface that our EnhancedWallet satisfies.
 */
type ClobClientSigner = ConstructorParameters<typeof ClobClient>[2];

/**
 * Cast EnhancedWallet to ClobClient's signer type.
 */
function asClobClientSigner(wallet: EnhancedWallet): ClobClientSigner {
  return wallet as ClobClientSigner;
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
  protected polymarketRuntime: IAgentRuntime;
  private walletAddress: string | null = null;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.polymarketRuntime = runtime;
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
    await service.initializeAuthenticatedClient();

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
    // ClobClient cleanup if needed

    logger.info("Polymarket service shutdown");
  }

  /**
   * Get the private key from runtime settings
   */
  private getPrivateKey(): `0x${string}` {
    const privateKeySetting =
      this.polymarketRuntime.getSetting("POLYMARKET_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("EVM_PRIVATE_KEY") ||
      this.polymarketRuntime.getSetting("WALLET_PRIVATE_KEY");

    if (!privateKeySetting) {
      throw new Error(
        "No private key found. Please set POLYMARKET_PRIVATE_KEY, EVM_PRIVATE_KEY, or WALLET_PRIVATE_KEY"
      );
    }

    // Convert to string and ensure it has 0x prefix
    const privateKey = String(privateKeySetting);
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return key as `0x${string}`;
  }

  /**
   * Create an enhanced wallet object compatible with CLOB client
   */
  private createEnhancedWallet(privateKey: `0x${string}`): EnhancedWallet {
    const account = privateKeyToAccount(privateKey);

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    return {
      address: account.address,
      getAddress: async () => account.address,
      _signTypedData: async (
        domain: Record<string, unknown>,
        types: Record<string, unknown>,
        value: Record<string, unknown>
      ) => {
        return walletClient.signTypedData({
          account,
          domain: domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
          types: types as Parameters<typeof walletClient.signTypedData>[0]["types"],
          primaryType: Object.keys(types).find((k) => k !== "EIP712Domain") ?? "",
          message: value,
        });
      },
    };
  }

  /**
   * Initialize the basic CLOB client for read operations
   */
  private async initializeClobClient(): Promise<void> {
    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const account = privateKeyToAccount(privateKey);
    this.walletAddress = account.address;

    logger.info(`Initializing CLOB client for address: ${account.address}`);

    const enhancedWallet = this.createEnhancedWallet(privateKey);

    this.clobClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      asClobClientSigner(enhancedWallet),
      undefined
    );

    logger.info("CLOB client initialized successfully");
  }

  /**
   * Initialize authenticated client with API credentials
   */
  private async initializeAuthenticatedClient(): Promise<void> {
    const apiKey = this.polymarketRuntime.getSetting("CLOB_API_KEY");
    const apiSecret =
      this.polymarketRuntime.getSetting("CLOB_API_SECRET") ||
      this.polymarketRuntime.getSetting("CLOB_SECRET");
    const apiPassphrase =
      this.polymarketRuntime.getSetting("CLOB_API_PASSPHRASE") ||
      this.polymarketRuntime.getSetting("CLOB_PASS_PHRASE");

    if (!apiKey || !apiSecret || !apiPassphrase) {
      throw new Error("API credentials not configured");
    }

    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const enhancedWallet = this.createEnhancedWallet(privateKey);

    const creds: ApiKeyCreds = {
      key: String(apiKey),
      secret: String(apiSecret),
      passphrase: String(apiPassphrase),
    };

    this.authenticatedClient = new ClobClient(
      clobApiUrl,
      POLYGON_CHAIN_ID,
      asClobClientSigner(enhancedWallet),
      creds
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
      const walletData: PolymarketWalletData = {
        address: this.walletAddress,
        chainId: POLYGON_CHAIN_ID,
        usdcBalance: "0", // Would be fetched from chain
        timestamp: Date.now(),
      };

      await this.polymarketRuntime.setCache(POLYMARKET_WALLET_DATA_CACHE_KEY, walletData);
      logger.debug("Polymarket wallet data refreshed");
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error refreshing wallet data:", errorMsg);
    }
  }

  /**
   * Get cached wallet data
   */
  async getCachedData(): Promise<PolymarketWalletData | undefined> {
    return this.polymarketRuntime.getCache<PolymarketWalletData>(POLYMARKET_WALLET_DATA_CACHE_KEY);
  }

  /**
   * Check if authenticated client is available
   */
  hasAuthenticatedClient(): boolean {
    return this.authenticatedClient !== null;
  }
}

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import {
  CACHE_REFRESH_INTERVAL_MS,
  DEFAULT_CLOB_API_URL,
  POLYGON_CHAIN_ID,
  POLYMARKET_SERVICE_NAME,
  POLYMARKET_WALLET_DATA_CACHE_KEY,
} from "../constants";
import type { ApiKeyCreds } from "../types";

export interface PolymarketWalletData {
  readonly address: string;
  readonly chainId: number;
  readonly usdcBalance: string;
  readonly timestamp: number;
}

type ClobClientSigner = ConstructorParameters<typeof ClobClient>[2];

function createClobClientSigner(privateKey: `0x${string}`): ClobClientSigner {
  return new Wallet(privateKey);
}

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

  static async start(runtime: IAgentRuntime): Promise<PolymarketService> {
    const service = new PolymarketService(runtime);

    await service.initializeClobClient();
    await service.initializeAuthenticatedClient();

    if (service.refreshInterval) {
      clearInterval(service.refreshInterval);
    }

    service.refreshInterval = setInterval(
      () => service.refreshWalletData(),
      CACHE_REFRESH_INTERVAL_MS
    );

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(POLYMARKET_SERVICE_NAME);
    if (!service) {
      return;
    }

    const polymarketService = service as PolymarketService;
    await polymarketService.stop();
  }

  async stop(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

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

    const privateKey = String(privateKeySetting);
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return key as `0x${string}`;
  }

  private async initializeClobClient(): Promise<void> {
    const clobApiUrlSetting =
      this.polymarketRuntime.getSetting("CLOB_API_URL") || DEFAULT_CLOB_API_URL;
    const clobApiUrl = String(clobApiUrlSetting);

    const privateKey = this.getPrivateKey();
    const signer = createClobClientSigner(privateKey);
    const wallet = signer instanceof Wallet ? signer : null;
    this.walletAddress = wallet ? wallet.address : await signer.getAddress();

    this.clobClient = new ClobClient(clobApiUrl, POLYGON_CHAIN_ID, signer, undefined);
  }

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
    const signer = createClobClientSigner(privateKey);

    const creds: ApiKeyCreds = {
      key: String(apiKey),
      secret: String(apiSecret),
      passphrase: String(apiPassphrase),
    };

    this.authenticatedClient = new ClobClient(clobApiUrl, POLYGON_CHAIN_ID, signer, creds);
  }

  getClobClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error("CLOB client not initialized");
    }
    return this.clobClient;
  }

  getAuthenticatedClient(): ClobClient {
    if (!this.authenticatedClient) {
      throw new Error(
        "Authenticated CLOB client not initialized. Please configure API credentials."
      );
    }
    return this.authenticatedClient;
  }

  getWalletAddress(): string {
    if (!this.walletAddress) {
      throw new Error("Wallet not initialized");
    }
    return this.walletAddress;
  }

  async refreshWalletData(): Promise<void> {
    if (!this.clobClient || !this.walletAddress) {
      return;
    }

    try {
      const walletData: PolymarketWalletData = {
        address: this.walletAddress,
        chainId: POLYGON_CHAIN_ID,
        usdcBalance: "0",
        timestamp: Date.now(),
      };

      await this.polymarketRuntime.setCache(POLYMARKET_WALLET_DATA_CACHE_KEY, walletData);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error refreshing wallet data:", errorMsg);
    }
  }

  async getCachedData(): Promise<PolymarketWalletData | undefined> {
    return this.polymarketRuntime.getCache<PolymarketWalletData>(POLYMARKET_WALLET_DATA_CACHE_KEY);
  }

  hasAuthenticatedClient(): boolean {
    return this.authenticatedClient !== null;
  }
}

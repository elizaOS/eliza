import { IAgentRuntime, Service, logger } from "@elizaos/core";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, Keypair } from "@solana/web3.js";

export class RaydiumSdkService extends Service {
  public static readonly serviceType = "RaydiumSdkService";
  public readonly capabilityDescription =
    "Provides a shared and initialized Raydium SDK V2 instance.";

  private _sdk: Raydium | null = null;
  private _connection: Connection | null = null;
  private _owner: Keypair | null = null;
  public isInitialized = false;
  private lastTokenFetch = 0;
  private readonly TOKEN_FETCH_INTERVAL = 60000; // 1 minute

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    const service = new RaydiumSdkService(runtime);
    await service.start();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(
      RaydiumSdkService.serviceType,
    ) as RaydiumSdkService;
    if (service) {
      await service.stop();
    }
  }

  public get sdk(): Raydium {
    if (!this._sdk || !this.isInitialized) {
      throw new Error(
        "RaydiumSdkService has not been initialized. Call load() first.",
      );
    }
    return this._sdk;
  }

  public get owner(): Keypair {
    if (!this._owner || !this.isInitialized) {
      throw new Error(
        "RaydiumSdkService has not been initialized. Call load() first.",
      );
    }
    return this._owner;
  }

  public get connection(): Connection {
    if (!this._connection || !this.isInitialized) {
      throw new Error(
        "RaydiumSdkService has not been initialized. Call load() first.",
      );
    }
    return this._connection;
  }

  async ensureTokenAccounts(force = false): Promise<void> {
    const now = Date.now();
    if (force || now - this.lastTokenFetch > this.TOKEN_FETCH_INTERVAL) {
      logger.info("Fetching wallet token accounts...");
      await this.sdk.account.fetchWalletTokenAccounts();
      this.lastTokenFetch = now;
      logger.info("Token accounts fetched.");
    }
  }

  async load(owner: Keypair): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Raydium SDK Service already initialized.");
      return;
    }

    logger.info("Initializing Raydium SDK Service...");

    // Try multiple RPC URL settings (Helius first, then general Solana RPC)
    const rpcUrl =
      this.runtime.getSetting("HELIUS_RPC_URL") ||
      this.runtime.getSetting("SOLANA_RPC_URL") ||
      this.runtime.getSetting("RPC_URL") ||
      "https://api.mainnet-beta.solana.com";

    // Determine cluster from RPC URL
    const cluster = rpcUrl.includes("devnet") ? "devnet" : "mainnet";

    logger.info(`Using RPC URL: ${rpcUrl}`);
    logger.info(`Using cluster: ${cluster}`);

    this._connection = new Connection(rpcUrl, "confirmed");
    this._owner = owner;

    try {
      this._sdk = await Raydium.load({
        owner,
        connection: this._connection,
        cluster: cluster as "mainnet" | "devnet",
        disableFeatureCheck: true,
        disableLoadToken: false,
        blockhashCommitment: "finalized",
      });

      // Force load the token accounts for the owner
      await this._sdk.account.fetchWalletTokenAccounts();

      // Add a small delay to allow for RPC propagation
      await new Promise((resolve) => setTimeout(resolve, 2000));

      this.isInitialized = true;
      this.lastTokenFetch = Date.now();
      logger.info(
        "Raydium SDK Service initialized successfully and token accounts loaded.",
      );
    } catch (error) {
      logger.error("Failed to initialize Raydium SDK:", error);
      throw error;
    }
  }

  async start(): Promise<void> {
    // For the RaydiumSdkService, initialization is deferred to the load() method
    // so the owner can be provided. This start() method is called by the runtime
    // during service registration, but the actual SDK initialization happens when
    // load() is called with a wallet keypair.
    logger.info(
      "RaydiumSdkService registered - SDK will be initialized when load() is called",
    );
  }

  async stop(): Promise<void> {
    this._sdk = null;
    this.isInitialized = false;
    logger.info("Raydium SDK Service stopped.");
  }
}

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  CACHE_REFRESH_INTERVAL_MS,
  EVM_SERVICE_NAME,
  EVM_WALLET_DATA_CACHE_KEY,
} from "./constants";
import { initWalletProvider, type WalletProvider } from "./providers/wallet";
import { EVMError, EVMErrorCode, type SupportedChain } from "./types";

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

export class EVMService extends Service {
  static override serviceType: string = EVM_SERVICE_NAME;
  capabilityDescription = "EVM blockchain wallet access";

  private walletProvider: WalletProvider | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  static async start(runtime: IAgentRuntime): Promise<EVMService> {
    logger.log("Initializing EVMService");

    const evmService = new EVMService(runtime);
    evmService.walletProvider = await initWalletProvider(runtime);
    await evmService.refreshWalletData();

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

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(EVM_SERVICE_NAME);
    if (!service) {
      logger.error("EVMService not found");
      return;
    }

    const evmService = service as EVMService;
    await evmService.stop();
  }

  async stop(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    logger.log("EVM service shutdown");
  }

  async refreshWalletData(): Promise<void> {
    if (!this.walletProvider) {
      this.walletProvider = await initWalletProvider(this.runtime);
    }

    const address = this.walletProvider.getAddress();
    const balances = await this.walletProvider.getWalletBalances();

    const chainDetails: Array<{
      chainName: string;
      name: string;
      balance: string;
      symbol: string;
      chainId: number;
    }> = [];

    for (const [chainName, balance] of Object.entries(balances)) {
      try {
        const chain = this.walletProvider.getChainConfigs(chainName as SupportedChain);
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

    await this.runtime.setCache(EVM_WALLET_DATA_CACHE_KEY, walletData);

    logger.log(
      "EVM wallet data refreshed for chains:",
      chainDetails.map((c) => c.chainName).join(", ")
    );
  }

  async getCachedData(): Promise<EVMWalletData | undefined> {
    const cachedData = await this.runtime.getCache<EVMWalletData>(EVM_WALLET_DATA_CACHE_KEY);
    const now = Date.now();

    if (!cachedData || now - cachedData.timestamp > CACHE_REFRESH_INTERVAL_MS) {
      logger.log("EVM wallet data is stale, refreshing...");
      await this.refreshWalletData();
      return await this.runtime.getCache<EVMWalletData>(EVM_WALLET_DATA_CACHE_KEY);
    }

    return cachedData;
  }

  async forceUpdate(): Promise<EVMWalletData | undefined> {
    await this.refreshWalletData();
    return this.getCachedData();
  }

  getWalletProvider(): WalletProvider {
    if (!this.walletProvider) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet provider not initialized");
    }
    return this.walletProvider;
  }
}

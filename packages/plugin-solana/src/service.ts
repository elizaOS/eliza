import { type IAgentRuntime, Service, logger } from '@elizaos/core';
import { Connection, PublicKey } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants';
import { getWalletKey } from './keypairUtils';
import type { Item, Prices, WalletPortfolio } from './types';

const PROVIDER_CONFIG = {
  BIRDEYE_API: 'https://public-api.birdeye.so',
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  DEFAULT_RPC: 'https://api.mainnet-beta.solana.com',
  TOKEN_ADDRESSES: {
    SOL: 'So11111111111111111111111111111111111111112',
    BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  },
};

/**
 * Service class for interacting with the Solana blockchain and accessing wallet data.
 * @extends Service
 */
export class SolanaService extends Service {
  static serviceType: string = SOLANA_SERVICE_NAME;
  capabilityDescription =
    'The agent is able to interact with the Solana blockchain, and has access to the wallet data';

  private updateInterval: NodeJS.Timer | null = null;
  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL = 120000; // 2 minutes
  private connection: Connection;
  private publicKey: PublicKey;

  /**
   * Constructor for creating an instance of the class.
   * @param {IAgentRuntime} runtime - The runtime object that provides access to agent-specific functionality.
   */
  constructor(protected runtime: IAgentRuntime) {
    super();
    const connection = new Connection(
      runtime.getSetting('SOLANA_RPC_URL') || PROVIDER_CONFIG.DEFAULT_RPC
    );
    this.connection = connection;
    getWalletKey(runtime, false).then(({ publicKey }) => {
      this.publicKey = publicKey;
    });
  }

  /**
   * Starts the Solana service with the given agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for the Solana service.
   * @returns {Promise<SolanaService>} The initialized Solana service.
   */
  static async start(runtime: IAgentRuntime): Promise<SolanaService> {
    logger.log('initSolanaService');

    const solanaService = new SolanaService(runtime);

    logger.log('SolanaService start');
    if (solanaService.updateInterval) {
      clearInterval(solanaService.updateInterval);
    }

    solanaService.updateInterval = setInterval(async () => {
      logger.log('Updating wallet data');
      await solanaService.updateWalletData();
    }, solanaService.UPDATE_INTERVAL);

    // Initial update
    solanaService.updateWalletData().catch(console.error);

    return solanaService;
  }

  /**
   * Stops the Solana service.
   *
   * @param {IAgentRuntime} runtime - The agent runtime.
   * @returns {Promise<void>} - A promise that resolves once the Solana service has stopped.
   */
  static async stop(runtime: IAgentRuntime) {
    const client = runtime.getService(SOLANA_SERVICE_NAME);
    if (!client) {
      logger.error('SolanaService not found');
      return;
    }
    await client.stop();
  }

  /**
   * Stops the update interval if it is currently running.
   * @returns {Promise<void>} A Promise that resolves when the update interval is stopped.
   */
  async stop(): Promise<void> {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Fetches data from the provided URL with retry logic.
   * @param {string} url - The URL to fetch data from.
   * @param {RequestInit} [options={}] - The options for the fetch request.
   * @returns {Promise<unknown>} - A promise that resolves to the fetched data.
   */
  private async fetchWithRetry(url: string, options: RequestInit = {}): Promise<unknown> {
    let lastError: Error;

    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Accept: 'application/json',
            'x-chain': 'solana',
            'X-API-KEY': this.runtime.getSetting('BIRDEYE_API_KEY'),
            ...options.headers,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        return await response.json();
      } catch (error) {
        logger.error(`Attempt ${i + 1} failed:`, error);
        lastError = error;
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY * 2 ** i));
        }
      }
    }

    throw lastError;
  }

  /**
   * Asynchronously fetches the prices of SOL, BTC, and ETH tokens.
   * Uses cache to store and retrieve prices if available.
   * @returns A Promise that resolves to an object containing the prices of SOL, BTC, and ETH tokens.
   */
  private async fetchPrices(): Promise<Prices> {
    const cacheKey = 'prices';
    const cachedValue = await this.runtime.getCache<Prices>(cacheKey);

    // if cachedValue is JSON, parse it
    if (cachedValue) {
      logger.log('Cache hit for fetchPrices');
      return cachedValue;
    }

    logger.log('Cache miss for fetchPrices');
    const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
    const tokens = [SOL, BTC, ETH];
    const prices: Prices = {
      solana: { usd: '0' },
      bitcoin: { usd: '0' },
      ethereum: { usd: '0' },
    };

    for (const token of tokens) {
      const response = await this.fetchWithRetry(
        `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`
      );

      if (response?.data?.value) {
        const price = response.data.value.toString();
        prices[token === SOL ? 'solana' : token === BTC ? 'bitcoin' : 'ethereum'].usd = price;
      }
    }

    await this.runtime.setCache<Prices>(cacheKey, prices);
    return prices;
  }

  /**
   * Asynchronously fetches token accounts for a specific owner.
   *
   * @returns {Promise<any[]>} A promise that resolves to an array of token accounts.
   */
  private async getTokenAccounts() {
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });
      return accounts.value;
    } catch (error) {
      logger.error('Error fetching token accounts:', error);
      return [];
    }
  }

  /**
   * Update wallet data including fetching wallet portfolio information, prices, and caching the data.
   * @param {boolean} [force=false] - Whether to force update the wallet data even if the update interval has not passed
   * @returns {Promise<WalletPortfolio>} The updated wallet portfolio information
   */
  private async updateWalletData(force = false): Promise<WalletPortfolio> {
    const now = Date.now();

    // Don't update if less than interval has passed, unless forced
    if (!force && now - this.lastUpdate < this.UPDATE_INTERVAL) {
      const cached = await this.getCachedData();
      if (cached) return cached;
    }

    try {
      // Try Birdeye API first
      const birdeyeApiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
      if (birdeyeApiKey) {
        const walletData = await this.fetchWithRetry(
          `${PROVIDER_CONFIG.BIRDEYE_API}/v1/wallet/token_list?wallet=${this.publicKey.toBase58()}`
        );

        if (walletData?.success && walletData?.data) {
          const data = walletData.data;
          const totalUsd = new BigNumber(data.totalUsd.toString());
          const prices = await this.fetchPrices();
          const solPriceInUSD = new BigNumber(prices.solana.usd);

          const portfolio: WalletPortfolio = {
            totalUsd: totalUsd.toString(),
            totalSol: totalUsd.div(solPriceInUSD).toFixed(6),
            prices,
            lastUpdated: now,
            items: data.items.map((item: Item) => ({
              ...item,
              valueSol: new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6),
              name: item.name || 'Unknown',
              symbol: item.symbol || 'Unknown',
              priceUsd: item.priceUsd || '0',
              valueUsd: item.valueUsd || '0',
            })),
          };

          await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
          this.lastUpdate = now;
          return portfolio;
        }
      }

      // Fallback to basic token account info
      const accounts = await this.getTokenAccounts();
      const items: Item[] = accounts.map((acc) => ({
        name: 'Unknown',
        address: acc.account.data.parsed.info.mint,
        symbol: 'Unknown',
        decimals: acc.account.data.parsed.info.tokenAmount.decimals,
        balance: acc.account.data.parsed.info.tokenAmount.amount,
        uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount.toString(),
        priceUsd: '0',
        valueUsd: '0',
        valueSol: '0',
      }));

      const portfolio: WalletPortfolio = {
        totalUsd: '0',
        totalSol: '0',
        items,
      };

      await this.runtime.setCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
      this.lastUpdate = now;
      return portfolio;
    } catch (error) {
      logger.error('Error updating wallet data:', error);
      throw error;
    }
  }

  /**
   * Retrieves cached wallet portfolio data from the database adapter.
   * @returns A promise that resolves with the cached WalletPortfolio data if available, otherwise resolves with null.
   */
  public async getCachedData(): Promise<WalletPortfolio | null> {
    const cachedValue = await this.runtime.getCache<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
    if (cachedValue) {
      return cachedValue;
    }
    return null;
  }

  /**
   * Forces an update of the wallet data and returns the updated WalletPortfolio object.
   * @returns A promise that resolves with the updated WalletPortfolio object.
   */
  public async forceUpdate(): Promise<WalletPortfolio> {
    return await this.updateWalletData(true);
  }

  /**
   * Retrieves the public key of the instance.
   *
   * @returns {PublicKey} The public key of the instance.
   */
  public getPublicKey(): PublicKey {
    return this.publicKey;
  }

  /**
   * Retrieves the connection object.
   *
   * @returns {Connection} The connection object.
   */
  public getConnection(): Connection {
    return this.connection;
  }
}

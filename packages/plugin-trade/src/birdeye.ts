import { Service, logger } from '@elizaos/core';

// simulate birdeye plugin service

export async function birdeyeStart(runtime) {
  console.log('birdeyeStartOut');
  return new Promise(async (resolve) => {
    resolve();
    console.log('birdeyeStartIn');
    let service = runtime.getService('TRADER_DATAPROVIDER');
    while (!service) {
      console.log('birdeye waiting for Trading info service...');
      service = runtime.getService('TRADER_DATAPROVIDER');
      if (!service) {
        await new Promise((waitResolve) => setTimeout(waitResolve, 1000));
      } else {
        console.log('birdeye Acquired trading chain service...');
      }
    }
    const me = {
      name: 'Birdeye',
      trendingService: 'BIRDEYE_TRENDING',
    };
    await service.registerDataProvder(me);

    // register a service...
    runtime.registerService(BirdeyeTrendingService);
    console.log('birdeyeStart done');
  });
}

export class BirdeyeTrendingService extends Service {
  private isRunning = false;

  static serviceType = 'BIRDEYE_TRENDING';
  capabilityDescription = 'The agent is able to get birdeye trending updates';

  // config (key/string)

  constructor(public runtime: IAgentRuntime) {
    super(runtime); // sets this.runtime
    this.apiKey = runtime.getSetting('BIRDEYE_API_KEY');
  }

  async getTrending() {
    console.log('birdeye needs to get trending data');
    this.syncTrendingTokens('solana');
    return this.runtime.getCache<IToken[]>(`tokens_solana`);
  }

  async syncTrendingTokens(chain: 'solana' | 'base'): Promise<boolean> {
    try {
      const options = {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-chain': chain,
          'X-API-KEY': this.apiKey,
        },
      };

      // Get existing tokens
      const cachedTokens = await this.runtime.getCache<IToken[]>(`tokens_${chain}`);
      const tokens: IToken[] = cachedTokens ? cachedTokens : [];

      /** Fetch top 100 in batches of 20 (which is the limit) */
      for (let batch = 0; batch < 5; batch++) {
        const currentOffset = batch * 20;
        const res = await fetch(
          `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=${currentOffset}&limit=20`,
          options
        );
        const resp = await res.json();
        //console.log('trending', resp)
        const data = resp?.data;
        const last_updated = new Date(data?.updateUnixTime * 1000);
        const newTokens = data?.tokens;

        if (!newTokens) {
          continue;
        }
        for (const token of newTokens) {
          const existingIndex = tokens.findIndex(
            (t) => t.provider === 'birdeye' && t.rank === token.rank && t.chain === chain
          );

          const tokenData: IToken = {
            address: token.address,
            chain: chain,
            provider: 'birdeye',
            decimals: token.decimals || 0,
            liquidity: token.liquidity || 0,
            logoURI: token.logoURI || '',
            name: token.name || token.symbol,
            symbol: token.symbol,
            marketcap: 0,
            volume24hUSD: token.volume24hUSD || 0,
            rank: token.rank || 0,
            price: token.price || 0,
            price24hChangePercent: token.price24hChangePercent || 0,
            last_updated,
          };

          if (existingIndex >= 0) {
            tokens[existingIndex] = tokenData;
          } else {
            tokens.push(tokenData);
          }
        }

        // Add extra delay
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      //console.log('trending tokens', tokens)
      await this.runtime.setCache<IToken[]>(`tokens_${chain}`, tokens);

      logger.debug(`Updated ${chain} tokens cache with ${tokens.length} tokens`);

      return true;
    } catch (error) {
      logger.error('Failed to sync trending tokens', error);
      throw error;
    }
  }

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new BirdeyeTrendingService(runtime);
    service.start();
    return service;
  }
  /**
   * Stops the Scenario service associated with the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to stop the service for.
   * @throws {Error} When the Scenario service is not found.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(this.serviceType);
    if (!service) {
      throw new Error(this.serviceType + ' service not found');
    }
    service.stop();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Birdeye trending service is already running');
      return;
    }

    try {
      logger.info('Starting Birdeye trending service...');

      this.isRunning = true;
      logger.info('Birdeye trending service started successfully');
    } catch (error) {
      logger.error('Error starting Birdeye trending service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Birdeye trending is not running');
      return;
    }

    try {
      logger.info('Stopping Birdeye trending service...');

      this.isRunning = false;
      logger.info('Birdeye trending service stopped successfully');
    } catch (error) {
      logger.error('Error stopping Birdeye trending service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

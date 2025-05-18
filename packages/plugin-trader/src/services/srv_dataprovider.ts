import { IAgentRuntime, Service, logger } from '@elizaos/core';
import { IToken } from '@elizaos/the-org/src/investmentManager/plugins/degen-intel/types';

export class TradeDataProviderService extends Service {
  private isRunning = false;

  static serviceType = 'TRADER_DATAPROVIDER';
  capabilityDescription = 'The agent is able to get information about blockchains';

  // config (key/string)

  constructor(public runtime: IAgentRuntime) {
    super(runtime); // sets this.runtime
    this.registry = {};
    console.log('TRADER_DATAPROVIDER cstr');
    this.events = new Map();
  }

  // return DataProvider handle
  async registerDataProvder(dataProvider: any) {
    // add to registry
    const id = Object.values(this.registry).length + 1;
    console.log('registered', dataProvider.name, 'as trading data provider #' + id);
    this.registry[id] = dataProvider;
    return id;
  }

  // interested in trending updates
  async interested_trending(handler) {
    const event = 'trending';
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    // add to our local eventHandlers
    this.events.get(event).push(handler);
  }

  // should be a task and not here
  async checkPositions() {
    console.log('checking positions');
    // get a list of positions (chains -> wallets -> positions)
  }

  // should this be a task?
  async updateTrending() {
    console.log('checking trending');
    // collect all
    const results = [];
    for (const dp of Object.values(this.registry)) {
      // foreach provider
      // do they have this type of service
      if (dp.trendingService) {
        // if so register handler with event
        const infoService = this.runtime.getService(dp.trendingService);
        if (infoService) {
          const result = await infoService.getTrending();
          //console.log('updateTrending - result', result)
          results.push(result);
        } else {
          console.warn('Registered data provider service not found', dp.trendingService);
        }
      }
    }
    // process results
    console.log('results', results);

    // emit event
    const event = 'trending';
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    console.log('trending registered handlers', this.events.get(event));
    const eventHandlers = this.events.get(event);
    for (const handler of eventHandlers) {
      handler(results);
    }

    // this doesn't go here, just temp hack
    this.checkPositions();
  }

  // interested in price delta events
  async interested_priceDelta(chain, token, handler) {
    const event = 'price_delta';
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }

    // for each provider in register
    for (const dp of Object.values(this.registry)) {
      // do they have this type of service
      if (dp.hasPriceDelta) {
        // if so register handler with event
        // add to our local eventHandlers
        this.events.get(event).push(handler);
      }
    }
  }

  async getTokenInfo(chain, address) {
    const token = await this.runtime.getCache<IToken[]>('token_' + chain + '_' + address);
    console.log('token', token);
    if (!token) {
      // not cache, go fetch realtime
    }
    // needs to include liquidity, 24h volume, suspicous atts
    return token;
  }

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    console.log('TRADER_DATAPROVIDER trying to start');
    const service = new TradeDataProviderService(runtime);
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
    const service = runtime.getService(TradeDataProviderService.serviceType);
    if (!service) {
      throw new Error(TradeDataProviderService.serviceType + ' service not found');
    }
    service.stop();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading info service is already running');
      return;
    }
    console.log('TRADER_DATAPROVIDER starting');

    // maybe we don't need to do this under the first registers
    this.timer = setTimeout(
      () => {
        this.updateTrending();
      },
      10 * 60 * 1000
    );
    // this is actually too soon
    //this.updateTrending()

    try {
      logger.info('Starting info trading service...');

      this.isRunning = true;
      logger.info('Trading info service started successfully');
    } catch (error) {
      logger.error('Error starting trading info service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading info service is not running');
      return;
    }

    try {
      logger.info('Stopping info trading info service...');

      this.isRunning = false;
      logger.info('Trading info service stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading info service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

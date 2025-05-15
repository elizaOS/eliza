import { Service, logger } from '@elizaos/core';

export class TradeStrategyService extends Service {
  private isRunning = false;

  static serviceType = 'TRADER_STRATEGY';
  capabilityDescription = 'The agent is able to use trade strategies';

  // config (key/string)

  constructor(public runtime: IAgentRuntime) {
    super(runtime); // sets this.runtime
  }

  /*
  - registry
  - what chain/tokens to listen on
  - open/close position (w/thinking)
  - update (reasoning/exit price) position
  */
  async register_strategy(strategy: any) {
    // return a handle?
  }

  // why is there here, why even bother stopping here
  /*
  async interested(chain, token, callback) {
    // register for token price changes on this chain
    this.infoService
  }
  */

  async open_position(stratHndl, pos) {}

  async update_position(stratHndl, posHndl, pos) {}

  async close_position(stratHndl, posHndl, closeInfo) {}

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new TradeStrategyService(runtime);
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
      logger.warn('Trading strategy service is already running');
      return;
    }

    this.chainService = this.runtime.getService('TRADER_CHAIN');
    while (!this.chainService) {
      console.log('waiting for Trading chain service...');
      this.chainService = this.runtime.getService('TRADER_CHAIN');
      if (!this.chainService) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        console.log('Acquired trading chain service...');
      }
    }

    this.infoService = this.runtime.getService('TRADER_DATAPROVIDER');
    while (!this.infoService) {
      console.log('waiting for Trading info service...');
      this.infoService = this.runtime.getService('TRADER_DATAPROVIDER');
      if (!this.infoService) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        console.log('Acquired trading info service...');
      }
    }

    try {
      logger.info('Starting strategy trading service...');

      this.isRunning = true;
      logger.info('Trading strategy service started successfully');
    } catch (error) {
      logger.error('Error starting trading strategy service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading service is not running');
      return;
    }

    try {
      logger.info('Stopping strategy trading service...');

      this.isRunning = false;
      logger.info('Trading strategy service stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading strategy service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

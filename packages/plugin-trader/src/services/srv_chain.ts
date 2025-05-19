import { Service, logger } from '@elizaos/core';

import { IAgentRuntime, Service, logger } from '@elizaos/core';

export class TradeChainService extends Service {
  private isRunning = false;
  private registry: Record<number, any> = {};

  static serviceType = 'TRADER_CHAIN';
  capabilityDescription = 'The agent is able to trade with blockchains';

  // config (key/string)

  constructor(public runtime: IAgentRuntime) {
    super(runtime); // sets this.runtime
    this.registry = {};
    logger.log('TRADER_CHAIN_SERVICE constructor');
  }

  /**
   * Registers a trading provider with the service.
   * @param {any} provider - The provider to register
   * @returns {Promise<number>} The ID assigned to the registered provider
   */
  async registerChain(provider: any): Promise<number> {
    const id = Object.values(this.registry).length + 1;
    logger.log('Registered', provider.name, 'as Trading Chain provider #' + id);
    this.registry[id] = provider;
    return id;
  }

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new TradeChainService(runtime);
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
      logger.warn('Trading chain service is already running');
      return;
    }

    try {
      logger.info('Starting chain trading service...');

      this.isRunning = true;
      logger.info('Trading chain service started successfully');
    } catch (error) {
      logger.error('Error starting trading chain service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Trading service is not running');
      return;
    }

    try {
      logger.info('Stopping chain trading service...');

      this.isRunning = false;
      logger.info('Trading service stopped successfully');
    } catch (error) {
      logger.error('Error stopping trading service:', error);
      throw error;
    }
  }

  isServiceRunning(): boolean {
    return this.isRunning;
  }
}

import type { Plugin } from '@elizaos/core';
import { type IAgentRuntime, Service, type ServiceTypeName, logger } from '@elizaos/core';
import { DpsnClient } from 'dpsn-client';
import mqtt from 'mqtt';

/**
 * Interface for DPSN publish data
 */
export interface DpsnPublishData {
  [key: string]: any;
}

export type DpsnConnectCallback = (response: any) => void;
export type DpsnErrorCallback = (error: any) => void;

/**
 * Service for interacting with DPSN (Decentralized Publish Subscribe Network)
 * Provides functionality for publishing and subscribing to topics
 */
export class DpsnService extends Service {
  static serviceType: ServiceTypeName = 'dpsn' as ServiceTypeName;
  capabilityDescription =
    'The agent is able to interact with DPSN for decentralized publish-subscribe messaging';

  private dpsnClient: DpsnClient; // Using any type to avoid TypeScript errors with DpsnClient
  protected runtime: IAgentRuntime | null = null;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  /**
   * Initializes DpsnService with the given runtime and settings
   * @param {IAgentRuntime} runtime - The runtime object
   * @returns {Promise<DpsnService>} - The DpsnService instance
   */
  static async start(runtime: IAgentRuntime): Promise<DpsnService> {
    logger.log('Initializing DpsnService');
    const service = new DpsnService(runtime);
    service.runtime = runtime;
    await service.initializeDpsnClient(
      runtime.getSetting('DPSN_URL'),
      runtime.getSetting('DPSN_WALLET_PVT_KEY')
    );
    return service;
  }

  /**
   * Stops the DPSN service
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<void>} - A promise that resolves once the service is stopped
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService('dpsn' as ServiceTypeName) as DpsnService;
    if (service) {
      await service.stop();
    }
  }

  /**
   * Asynchronously stops the DPSN client if it exists
   */
  async stop() {
    if (this.dpsnClient) {
      this.dpsnClient.disconnect();
      logger.log('DPSN Service stopped');
    }
  }

  /**
   * Initializes the DPSN client with the provided settings
   * @returns {Promise<void>}
   */
  private async initializeDpsnClient(dpsnUrl: string, pvtKey: string): Promise<void> {
    if (!this.runtime) {
      throw new Error('Runtime is not available');
    }

    if (!dpsnUrl) throw new Error('DPSN_URL is not defined in the environment variables');
    if (!pvtKey) throw new Error('DPSN_WALLET_PVT_KEY is not defined in the environment variables');

    this.dpsnClient = new DpsnClient(dpsnUrl, pvtKey, {
      wallet_chain_type: 'ethereum',
      network: 'testnet',
    });

    this.dpsnClient.init();

    logger.log('DPSN Service initialized');
  }

  /**
   * Register an event handler for DPSN events
   * @param eventType - The type of event to listen for ('connect', 'error', 'subscription', 'publish', 'disconnect')
   * @param callback - The callback function to execute when the event occurs
   * @returns This instance for method chaining
   */
  public on(eventType: string, callback: (...args: any[]) => void): this {
    this.dpsnClient.on(eventType, callback);
    return this;
  }

  /**
   * Gets the DPSN client instance
   * @returns {any} - The DPSN client instance
   */
  getDpsnClient(): any {
    return this.dpsnClient;
  }

  /**
   * Subscribe to a DPSN topic and handle incoming messages with a custom callback
   * @param {string} topicName - The main topic name to subscribe to
   * @param {function} callback - Custom callback function to process received messages
   * @param {string} [subtopic] - Optional subtopic
   * @returns {Promise<void>}
   */
  subscribe(
    topicName: string,
    callback: (topic: string, message: any, packet?: mqtt.IPublishPacket) => void,
    subtopic?: string
  ): void {
    const fullTopic = subtopic ? `${topicName}/${subtopic}` : topicName;

    // Log the subscription attempt
    logger.log(`Subscribing to DPSN topic: ${fullTopic}`);

    // Subscribe to the topic with a wrapper callback that logs and then forwards to the consumer's callback
    this.dpsnClient.subscribe(
      fullTopic,
      (topic: string, message: any, networkPacketDetails: mqtt.IPublishPacket) => {
        // Log the received message (optional, can be removed if not needed)
        logger.log(`[DPSN] Message received on topic: ${topic}`);

        // Forward the message to the consumer's callback
        callback(topic, message, networkPacketDetails);
      }
    );
  }
}

/**
 * DPSN Plugin definition
 */
export const dpsnPlugin: Plugin = {
  name: 'dpsn',
  description: 'Plugin for interacting with Decentralized Publish Subscribe Network',
  services: [DpsnService],
  actions: [],
};

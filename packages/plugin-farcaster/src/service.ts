import { elizaLogger, logger, Service, UUID, type IAgentRuntime } from '@elizaos/core';
import { Configuration, NeynarAPIClient } from '@neynar/nodejs-sdk';
import { FarcasterClient } from './client';
import { FARCASTER_SERVICE_NAME } from './constants';
import { validateFarcasterConfig, type FarcasterConfig } from './environment';
import { FarcasterInteractionManager } from './interactions';
import { FarcasterPostManager } from './post';

/**
 * A manager that orchestrates all Farcaster operations:
 * - client: base operations (Neynar client, hub connection, etc.)
 * - posts: autonomous posting logic
 * - interactions: handling mentions, replies, likes, etc.
 */
class FarcasterManager {
  client: FarcasterClient;
  posts: FarcasterPostManager;
  interactions: FarcasterInteractionManager;
  private signerUuid: string;

  constructor(runtime: IAgentRuntime, farcasterConfig: FarcasterConfig) {
    const cache = new Map<string, any>();
    this.signerUuid = runtime.getSetting('FARCASTER_NEYNAR_SIGNER_UUID')!;

    const neynarConfig = new Configuration({
      apiKey: runtime.getSetting('FARCASTER_NEYNAR_API_KEY')!,
    });

    const neynarClient = new NeynarAPIClient(neynarConfig);

    this.client = new FarcasterClient({
      runtime,
      ssl: true,
      url: runtime.getSetting('FARCASTER_HUB_URL') ?? 'hub.pinata.cloud',
      neynar: neynarClient,
      signerUuid: this.signerUuid,
      cache,
      farcasterConfig,
    });

    elizaLogger.success('Farcaster Neynar client initialized.');

    this.posts = new FarcasterPostManager(this.client, runtime, this.signerUuid, cache);

    this.interactions = new FarcasterInteractionManager(
      this.client,
      runtime,
      this.signerUuid,
      cache
    );
  }

  async start() {
    await Promise.all([this.posts.start(), this.interactions.start()]);
  }

  async stop() {
    await Promise.all([this.posts.stop(), this.interactions.stop()]);
  }
}
export class FarcasterService extends Service {
  private static instance: FarcasterService | undefined;
  private managers = new Map<UUID, FarcasterManager>();
  static serviceType: string = FARCASTER_SERVICE_NAME;
  readonly capabilityDescription = 'The agent is able to send and receive messages on farcaster';

  private static getInstance(): FarcasterService {
    if (!FarcasterService.instance) {
      FarcasterService.instance = new FarcasterService();
    }
    return FarcasterService.instance;
  }

  async stop(): Promise<void> {
    logger.log('Stopping ALL Farcaster services');
    for (const manager of Array.from(this.managers.values())) {
      const agentId = manager.client.runtime.agentId;
      try {
        await FarcasterService.stop(manager.client.runtime);
      } catch (error) {
        logger.error('Error stopping Farcaster service', agentId, error);
      }
    }
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = FarcasterService.getInstance();
    let manager = service.managers.get(runtime.agentId);

    if (manager) {
      logger.warn('Farcaster service already started');
      return service;
    }

    const farcasterConfig = validateFarcasterConfig(runtime);
    manager = new FarcasterManager(runtime, farcasterConfig);
    service.managers.set(runtime.agentId, manager);
    await manager.start();

    elizaLogger.log('Farcaster client started');
    return service;
  }

  /** Stop service connection */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = FarcasterService.getInstance();
    let manager = service.managers.get(runtime.agentId);
    if (manager) {
      await manager.stop();
      service.managers.delete(runtime.agentId);
    } else {
      logger.warn('Farcaster service not started', runtime.agentId);
    }
  }
}

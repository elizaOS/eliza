import { logger, type IAgentRuntime } from '@elizaos/core';
import { Configuration, NeynarAPIClient } from '@neynar/nodejs-sdk';
import { FarcasterClient } from '../client';
import { type FarcasterConfig } from '../common/types';
import { FarcasterInteractionManager } from './interactions';
import { FarcasterPostManager } from './post';

/**
 * A manager that orchestrates all Farcaster operations:
 * - client: base operations (Neynar client, hub connection, etc.)
 * - posts: autonomous posting logic
 * - interactions: handling mentions, replies, likes, etc.
 */
export class FarcasterAgentManager {
  readonly client: FarcasterClient;
  readonly posts: FarcasterPostManager;
  readonly interactions: FarcasterInteractionManager;

  constructor(runtime: IAgentRuntime, config: FarcasterConfig) {
    const cache = new Map<string, any>();
    const signerUuid = config.FARCASTER_NEYNAR_SIGNER_UUID;

    const neynarConfig = new Configuration({ apiKey: config.FARCASTER_NEYNAR_API_KEY });

    const neynarClient = new NeynarAPIClient(neynarConfig);

    const client = new FarcasterClient({
      runtime,
      ssl: true,
      url: config.FARCASTER_HUB_URL,
      neynar: neynarClient,
      signerUuid,
      cache,
      farcasterConfig: config,
    });

    this.client = client;

    logger.success('Farcaster Neynar client initialized.');

    this.posts = new FarcasterPostManager({ client, runtime, config });

    this.interactions = new FarcasterInteractionManager(client, runtime, signerUuid, cache);
  }

  async start() {
    await Promise.all([this.posts.start(), this.interactions.start()]);
  }

  async stop() {
    await Promise.all([this.posts.stop(), this.interactions.stop()]);
  }
}

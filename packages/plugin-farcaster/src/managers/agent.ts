import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { Configuration, NeynarAPIClient } from '@neynar/nodejs-sdk';
import { FarcasterClient } from '../client';
import { type FarcasterConfig } from '../common/environment';
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
  private signerUuid: string;

  constructor(runtime: IAgentRuntime, farcasterConfig: FarcasterConfig) {
    const cache = new Map<string, any>();
    this.signerUuid = farcasterConfig.FARCASTER_NEYNAR_SIGNER_UUID;

    const neynarConfig = new Configuration({ apiKey: farcasterConfig.FARCASTER_NEYNAR_API_KEY });

    const neynarClient = new NeynarAPIClient(neynarConfig);

    this.client = new FarcasterClient({
      runtime,
      ssl: true,
      url: farcasterConfig.FARCASTER_HUB_URL,
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

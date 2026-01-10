import { type IAgentRuntime } from '@elizaos/core';
import { Configuration, NeynarAPIClient } from '@neynar/nodejs-sdk';
import { FarcasterClient } from '../client';
import { type FarcasterConfig } from '../common/types';
import { FarcasterCastManager } from './post';
import { FarcasterInteractionManager } from './interactions';

/**
 * A manager that orchestrates all Farcaster operations:
 * - client: base operations (Neynar client, hub connection, etc.)
 * - posts: autonomous posting logic
 * - interactions: handling mentions, replies, likes, etc.
 */
export class FarcasterAgentManager {
  readonly runtime: IAgentRuntime;
  readonly client: FarcasterClient;
  readonly casts: FarcasterCastManager;
  readonly interactions: FarcasterInteractionManager;

  constructor(runtime: IAgentRuntime, config: FarcasterConfig) {
    this.runtime = runtime;
    const signerUuid = config.FARCASTER_SIGNER_UUID;

    const neynarConfig = new Configuration({ apiKey: config.FARCASTER_NEYNAR_API_KEY });
    const neynar = new NeynarAPIClient(neynarConfig);
    const client = new FarcasterClient({ neynar, signerUuid });

    this.client = client;

    runtime.logger.success('Farcaster Neynar client initialized.');

    // Initialize managers
    this.interactions = new FarcasterInteractionManager({ client, runtime, config });
    this.casts = new FarcasterCastManager({ client, runtime, config });
  }

  async start() {
    await Promise.all([this.casts.start(), this.interactions.start()]);
  }

  async stop() {
    await Promise.all([this.casts.stop(), this.interactions.stop()]);
  }
}

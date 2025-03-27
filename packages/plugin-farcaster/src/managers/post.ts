import { createUniqueUuid, EventType, type IAgentRuntime, logger } from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { standardCastHandlerCallback } from '../common/callbacks';
import { FARCASTER_SOURCE } from '../common/constants';
import { FarcasterConfig, FarcasterEventTypes, LastCast } from '../common/types';
import { lastCastCacheKey } from '../common/utils';

interface FarcasterPostParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
}

export class FarcasterPostManager {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  fid: number;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private config: FarcasterConfig;
  private isRunning: boolean = false;

  constructor(opts: FarcasterPostParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.fid = this.config.FARCASTER_FID;
  }

  public async start() {
    if (this.isRunning || !this.config.ENABLE_POST) {
      return;
    }

    this.isRunning = true;

    // never await this, it will block forever
    void this.runPeriodically();
  }

  public async stop() {
    if (this.timeout) clearTimeout(this.timeout);
    this.isRunning = false;
  }

  private calculateDelay(): { delay: number; randomMinutes: number } {
    const minMinutes = this.config.POST_INTERVAL_MIN;
    const maxMinutes = this.config.POST_INTERVAL_MAX;
    const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
    const delay = randomMinutes * 60 * 1000;
    return { delay, randomMinutes };
  }

  private async runPeriodically(): Promise<void> {
    if (this.config.POST_IMMEDIATELY) {
      await this.generateNewCast();
    }

    while (this.isRunning) {
      try {
        const lastPost = await this.runtime.getCache<LastCast>(lastCastCacheKey(this.fid));
        const lastPostTimestamp = lastPost?.timestamp ?? 0;
        const { delay, randomMinutes } = this.calculateDelay();

        if (Date.now() > lastPostTimestamp + delay) {
          await this.generateNewCast();
        }

        logger.log(`Next cast scheduled in ${randomMinutes} minutes`);
        await new Promise((resolve) => (this.timeout = setTimeout(resolve, delay)));
      } catch (error) {
        logger.error('[Farcaster] Error in periodic post:', this.runtime.agentId, error);
      }
    }
  }

  private async generateNewCast() {
    logger.info('Generating new cast');
    try {
      const worldId = createUniqueUuid(this.runtime, this.fid.toString());
      const roomId = createUniqueUuid(this.runtime, `${this.fid}-home`);

      // callback for handling the actual posting
      const callback = standardCastHandlerCallback({
        client: this.client,
        runtime: this.runtime,
        config: this.config,
        roomId,
        onCompletion: async (casts, _memories) => {
          const lastCast = casts[casts.length - 1];
          await this.runtime.setCache<LastCast>(lastCastCacheKey(this.fid), {
            hash: lastCast.hash,
            timestamp: new Date(lastCast.timestamp).getTime(),
          });
        },
      });

      this.runtime.emitEvent([EventType.POST_GENERATED, FarcasterEventTypes.POST_GENERATED], {
        runtime: this.runtime,
        callback,
        worldId,
        userId: this.runtime.agentId,
        roomId,
        source: FARCASTER_SOURCE,
      });
    } catch (error) {
      logger.error('Error generating new cast:', error);
    }
  }
}

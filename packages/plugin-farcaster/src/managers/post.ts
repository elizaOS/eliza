import {
  type IAgentRuntime,
  logger,
  ChannelType,
  createUniqueUuid,
  HandlerCallback,
  Content,
  EventType,
} from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { lastCastCacheKey } from '../common/utils';
import { createCastMemory } from '../memory';
import { sendCast } from '../actions';
import { FarcasterConfig, FarcasterEventTypes, LastCast } from '../common/types';
import { FARCASTER_SOURCE } from '../common/constants';

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

    if (this.config.POST_IMMEDIATELY) {
      await this.generateNewCast();
    }

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
        logger.error('Error running periodically:', this.runtime.agentId, error);
      }
    }
  }

  private async generateNewCast() {
    logger.info('Generating new cast');
    try {
      const profile = await this.client.getProfile(this.fid);
      const worldId = createUniqueUuid(this.runtime, this.fid.toString());
      const roomId = createUniqueUuid(this.runtime, `${this.fid}-home`);

      // callback for handling the actual posting
      const callback: HandlerCallback = async (content: Content) => {
        try {
          if (this.config.FARCASTER_DRY_RUN) {
            logger.info(`Dry run: would have cast: ${content.text}`);
            return [];
          }

          const castsPosted = await sendCast({
            client: this.client,
            runtime: this.runtime,
            roomId: roomId,
            content,
            profile,
          });

          if (castsPosted.length === 0) {
            logger.warn('No casts posted');
            return [];
          }

          const [{ cast }] = castsPosted;

          await this.runtime.setCache<LastCast>(lastCastCacheKey(this.fid), {
            hash: cast.hash,
            timestamp: Date.now(),
          });

          logger.success(`[Farcaster] Published cast ${cast.hash}`);

          const memory = createCastMemory({
            roomId,
            senderId: this.runtime.agentId,
            runtime: this.runtime,
            cast,
          });

          await this.runtime.createMemory(memory, 'messages');

          return [memory];
        } catch (error) {
          logger.error('Error posting cast:', error);
          return [];
        }
      };

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

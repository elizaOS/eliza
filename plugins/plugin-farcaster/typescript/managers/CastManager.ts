/**
 * Cast manager for autonomous posting.
 */

import { createUniqueUuid, EventType, type IAgentRuntime } from "@elizaos/core";
import type { FarcasterClient } from "../client/FarcasterClient";
import { standardCastHandlerCallback } from "../utils/callbacks";
import { FARCASTER_SOURCE, FarcasterEventTypes, type FarcasterConfig, type LastCast } from "../types";
import { lastCastCacheKey } from "../utils";

interface FarcasterCastParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
}

/**
 * Manager for autonomous cast generation.
 */
export class FarcasterCastManager {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  fid: number;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private config: FarcasterConfig;
  private isRunning: boolean = false;

  constructor(opts: FarcasterCastParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.fid = this.config.FARCASTER_FID;
  }

  async start(): Promise<void> {
    if (this.isRunning || !this.config.ENABLE_CAST) {
      return;
    }

    this.isRunning = true;

    void this.runPeriodically();
  }

  async stop(): Promise<void> {
    if (this.timeout) clearTimeout(this.timeout);
    this.isRunning = false;
  }

  private calculateDelay(): { delay: number; randomMinutes: number } {
    const minMinutes = this.config.CAST_INTERVAL_MIN;
    const maxMinutes = this.config.CAST_INTERVAL_MAX;
    const randomMinutes =
      Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
    const delay = randomMinutes * 60 * 1000;
    return { delay, randomMinutes };
  }

  private async runPeriodically(): Promise<void> {
    if (this.config.CAST_IMMEDIATELY) {
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

        this.runtime.logger.log(`Next cast scheduled in ${randomMinutes} minutes`);
        await new Promise((resolve) => (this.timeout = setTimeout(resolve, delay)));
      } catch (error) {
        this.runtime.logger.error(
          { agentId: this.runtime.agentId, error },
          "[Farcaster] Error in periodic cast loop:"
        );
      }
    }
  }

  private async generateNewCast(): Promise<void> {
    this.runtime.logger.info("Generating new cast");
    try {
      const worldId = createUniqueUuid(this.runtime, this.fid.toString());
      const roomId = createUniqueUuid(this.runtime, `${this.fid}-home`);

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

      this.runtime.emitEvent([EventType.POST_GENERATED, FarcasterEventTypes.CAST_GENERATED], {
        runtime: this.runtime,
        callback,
        worldId,
        userId: this.runtime.agentId,
        roomId,
        source: FARCASTER_SOURCE,
      });
    } catch (error) {
      this.runtime.logger.error({ error }, "[Farcaster] Error generating new cast");
    }
  }
}


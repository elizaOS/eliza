import type { IAgentRuntime } from "@elizaos/core";
import type { FarcasterClient } from "../client/FarcasterClient";
import type { FarcasterConfig, NeynarWebhookData } from "../types";
import { castUuid, neynarCastToCast } from "../utils";
import type { IInteractionProcessor } from "./InteractionProcessor";

interface FarcasterInteractionSourceParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
  processor: IInteractionProcessor;
}

export abstract class FarcasterInteractionSource {
  protected client: FarcasterClient;
  protected runtime: IAgentRuntime;
  protected config: FarcasterConfig;
  protected processor: IInteractionProcessor;
  protected isRunning: boolean = false;

  constructor(params: FarcasterInteractionSourceParams) {
    this.client = params.client;
    this.runtime = params.runtime;
    this.config = params.config;
    this.processor = params.processor;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

/**
 * Polling-based interaction source.
 */
export class FarcasterPollingSource extends FarcasterInteractionSource {
  private timeout: ReturnType<typeof setTimeout> | undefined;

  async start(): Promise<void> {
    this.runtime.logger.info("Starting Farcaster polling mode");
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    void this.runPeriodically();
  }

  async stop(): Promise<void> {
    this.runtime.logger.info("Stopping Farcaster polling mode");
    if (this.timeout) clearTimeout(this.timeout);
    this.isRunning = false;
  }

  private async runPeriodically(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.pollForInteractions();

        const delay = this.config.FARCASTER_POLL_INTERVAL * 1000;
        await new Promise((resolve) => {
          this.timeout = setTimeout(resolve, delay);
        });
      } catch (error) {
        this.runtime.logger.error({ error }, "[Farcaster] Error in polling:");
      }
    }
  }

  private async pollForInteractions(): Promise<void> {
    const agentFid = this.config.FARCASTER_FID;
    const mentions = await this.client.getMentions({
      fid: agentFid,
      pageSize: 20,
    });

    for (const cast of mentions) {
      try {
        const mention = neynarCastToCast(cast);
        const memoryId = castUuid({
          agentId: this.runtime.agentId,
          hash: mention.hash,
        });

        if (await this.runtime.getMemoryById(memoryId)) {
          continue;
        }

        this.runtime.logger.info({ hash: mention.hash }, "New Cast found");

        if (mention.authorFid === agentFid) {
          const memory = await this.processor.ensureCastConnection(mention);
          await this.runtime.addEmbeddingToMemory(memory);
          await this.runtime.createMemory(memory, "messages");
          continue;
        }

        await this.processor.processMention(cast);
      } catch (error) {
        this.runtime.logger.error({ error }, "[Farcaster] Error processing mention:");
      }
    }
  }
}

export class FarcasterWebhookSource extends FarcasterInteractionSource {
  async start(): Promise<void> {
    this.runtime.logger.info("Starting Farcaster webhook mode");
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.runtime.logger.info("Webhook source is active - waiting for webhook events");
  }

  async stop(): Promise<void> {
    this.runtime.logger.info("Stopping Farcaster webhook mode");
    this.isRunning = false;
  }

  async processWebhookData(webhookData: NeynarWebhookData): Promise<void> {
    if (!this.isRunning) {
      this.runtime.logger.warn("Webhook source is not running, ignoring webhook data");
      return;
    }

    try {
      await this.processor.processWebhookData(webhookData);
    } catch (error) {
      this.runtime.logger.error({ error }, "[Farcaster] Error processing webhook data:");
    }
  }
}

export function createFarcasterInteractionSource(
  params: FarcasterInteractionSourceParams
): FarcasterInteractionSource {
  const mode = params.config.FARCASTER_MODE;

  switch (mode) {
    case "webhook":
      return new FarcasterWebhookSource(params);
    default:
      return new FarcasterPollingSource(params);
  }
}

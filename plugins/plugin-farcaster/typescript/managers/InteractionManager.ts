import {
  ChannelType,
  createUniqueUuid,
  type EventPayload,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { Cast as NeynarCast } from "@neynar/nodejs-sdk/build/api";
import type { FarcasterClient } from "../client/FarcasterClient";
import {
  type Cast,
  FARCASTER_SOURCE,
  type FarcasterConfig,
  FarcasterEventTypes,
  type FarcasterGenericCastPayload,
  type NeynarWebhookData,
  type Profile,
} from "../types";
import { castUuid, neynarCastToCast } from "../utils";
import { AsyncQueue } from "../utils/asyncqueue";
import { standardCastHandlerCallback } from "../utils/callbacks";
import { EmbedManager } from "./EmbedManager";
import type { IInteractionProcessor } from "./InteractionProcessor";
import {
  createFarcasterInteractionSource,
  type FarcasterInteractionSource,
} from "./InteractionSource";

interface FarcasterInteractionManagerParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
}

export class FarcasterInteractionManager implements IInteractionProcessor {
  private client: FarcasterClient;
  private runtime: IAgentRuntime;
  private config: FarcasterConfig;
  private asyncQueue: AsyncQueue;
  private embedManager: EmbedManager;

  public readonly mode: "polling" | "webhook";
  public readonly source: FarcasterInteractionSource;

  constructor(opts: FarcasterInteractionManagerParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.asyncQueue = new AsyncQueue(1);
    this.embedManager = new EmbedManager(opts.runtime);

    this.mode = opts.config.FARCASTER_MODE as "polling" | "webhook";
    this.source = createFarcasterInteractionSource({
      client: this.client,
      runtime: this.runtime,
      config: this.config,
      processor: this,
    });

    this.runtime.logger.info(`Farcaster interaction mode: ${this.mode}`);
  }

  async processMention(cast: NeynarCast): Promise<void> {
    const agentFid = this.config.FARCASTER_FID;
    const agent = await this.client.getProfile(agentFid);
    const mention = neynarCastToCast(cast);

    if (mention.embeds && mention.embeds.length > 0) {
      try {
        this.runtime.logger.debug(
          { castHash: cast.hash, embedCount: mention.embeds.length },
          "[Farcaster] Processing embeds for mention"
        );
        const processedMedia = await this.embedManager.processEmbeds(mention.embeds);
        mention.media = processedMedia;
        this.runtime.logger.info(
          { castHash: cast.hash, mediaCount: processedMedia.length },
          "[Farcaster] Processed embeds for mention"
        );
      } catch (error) {
        this.runtime.logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            castHash: cast.hash,
          },
          "[Farcaster] Failed to process embeds, continuing without media"
        );
      }
    }

    await this.handleMentionCast({ agent, mention, cast });
  }

  async processReply(cast: NeynarCast): Promise<void> {
    const agentFid = this.config.FARCASTER_FID;
    const agent = await this.client.getProfile(agentFid);
    const reply = neynarCastToCast(cast);

    if (reply.embeds && reply.embeds.length > 0) {
      try {
        this.runtime.logger.debug(
          { castHash: cast.hash, embedCount: reply.embeds.length },
          "[Farcaster] Processing embeds for reply"
        );
        const processedMedia = await this.embedManager.processEmbeds(reply.embeds);
        reply.media = processedMedia;
        this.runtime.logger.info(
          { castHash: cast.hash, mediaCount: processedMedia.length },
          "[Farcaster] Processed embeds for reply"
        );
      } catch (error) {
        this.runtime.logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            castHash: cast.hash,
          },
          "[Farcaster] Failed to process embeds, continuing without media"
        );
      }
    }

    await this.handleMentionCast({ agent, mention: reply, cast });
  }

  async processWebhookData(webhookData: NeynarWebhookData): Promise<void> {
    if (webhookData.type !== "cast.created" || !webhookData.data) {
      this.runtime.logger.debug("Ignoring non-cast webhook event:", webhookData.type);
      return;
    }

    const castData = webhookData.data;
    const agentFid = this.config.FARCASTER_FID;

    if (!castData.author || !castData.hash || typeof castData.author.fid !== "number") {
      this.runtime.logger.warn(
        "Invalid webhook cast data structure - missing author, hash, or author.fid"
      );
      return;
    }

    if (castData.author.fid === agentFid) {
      this.runtime.logger.debug("Skipping webhook event from agent itself");
      return;
    }

    const memoryId = castUuid({
      agentId: this.runtime.agentId,
      hash: castData.hash,
    });
    if (await this.runtime.getMemoryById(memoryId)) {
      this.runtime.logger.debug("Skipping already processed webhook cast:", castData.hash);
      return;
    }

    const isMention = castData.mentioned_profiles?.some(
      (profile: { fid: number }) => profile.fid === agentFid
    );

    const isReply = castData.parent_hash && castData.parent_author?.fid === agentFid;

    if (isMention) {
      const username = castData.author.username || "unknown";
      const text = castData.text || "";
      this.runtime.logger.info(`Processing webhook MENTION from @${username}: "${text}"`);

      try {
        const neynarCast = await this.client.getCast(castData.hash);
        await this.processMention(neynarCast);
      } catch (error) {
        this.runtime.logger.error(
          { agentId: this.runtime.agentId, error },
          `Failed to process webhook mention from @${username}`
        );
      }
    } else if (isReply) {
      const username = castData.author.username || "unknown";
      const text = castData.text || "";
      this.runtime.logger.info(`Processing webhook REPLY from @${username}: "${text}"`);

      try {
        const neynarCast = await this.client.getCast(castData.hash);
        await this.processReply(neynarCast);
      } catch (error) {
        this.runtime.logger.error({ error }, `Failed to process webhook reply from @${username}:`);
      }
    } else {
      this.runtime.logger.debug("Webhook cast is neither mention nor reply to agent");
    }
  }

  async ensureCastConnection(cast: Cast): Promise<Memory> {
    return await this.asyncQueue.submit(async () => {
      const memoryId = castUuid({
        agentId: this.runtime.agentId,
        hash: cast.hash,
      });
      const conversationId = cast.threadId ?? cast.inReplyTo?.hash ?? cast.hash;
      const entityId = createUniqueUuid(this.runtime, cast.authorFid.toString());
      const worldId = createUniqueUuid(this.runtime, cast.authorFid.toString());
      const roomId = createUniqueUuid(this.runtime, conversationId);

      if (entityId !== this.runtime.agentId) {
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          worldName: `${cast.profile.username}'s Farcaster`,
          userName: cast.profile.username,
          name: cast.profile.name,
          source: FARCASTER_SOURCE,
          type: ChannelType.THREAD,
          channelId: conversationId,
          messageServerId: stringToUuid(cast.authorFid.toString()),
          worldId,
          metadata: {
            ownership: { ownerId: cast.authorFid.toString() },
            farcaster: {
              username: cast.profile.username,
              id: cast.authorFid.toString(),
              name: cast.profile.name,
            },
          },
        });
      }

      let text = cast.text;
      if (cast.media && cast.media.length > 0) {
        const attachmentTypes = cast.media.map((m) => m.source || "attachment").join(", ");
        text = `${cast.text}\n\n(Attachments: ${cast.media.length} - ${attachmentTypes})`;
      }

      const memory: Memory = {
        id: memoryId,
        agentId: this.runtime.agentId,
        content: {
          text,
          inReplyTo: cast.inReplyTo?.hash
            ? castUuid({
                agentId: this.runtime.agentId,
                hash: cast.inReplyTo.hash,
              })
            : undefined,
          source: FARCASTER_SOURCE,
          channelType: ChannelType.THREAD,
          attachments: cast.media && cast.media.length > 0 ? cast.media : undefined,
        },
        entityId,
        roomId,
        createdAt: cast.timestamp.getTime(),
      };

      return memory;
    });
  }

  private async buildThreadForCast(cast: Cast, skipMemoryId: Set<UUID>): Promise<Cast[]> {
    const thread: Cast[] = [];
    const visited: Set<string> = new Set();
    const client = this.client;
    const runtime = this.runtime;
    const self = this;

    async function processThread(currentCast: Cast): Promise<void> {
      const memoryId = castUuid({
        hash: currentCast.hash,
        agentId: runtime.agentId,
      });

      if (visited.has(currentCast.hash) || skipMemoryId.has(memoryId)) {
        return;
      }

      visited.add(currentCast.hash);

      const memory = await runtime.getMemoryById(memoryId);

      if (!memory) {
        runtime.logger.info({ hash: currentCast.hash }, "Creating memory for cast");
        const newMemory = await self.ensureCastConnection(currentCast);
        await runtime.createMemory(newMemory, "messages");
        runtime.emitEvent(
          FarcasterEventTypes.THREAD_CAST_CREATED as string,
          {
            runtime,
            memory: newMemory,
            cast: currentCast,
            source: FARCASTER_SOURCE,
          } as EventPayload
        );
      }

      thread.unshift(currentCast);

      if (currentCast.inReplyTo) {
        const parentCast = await client.getCast(currentCast.inReplyTo.hash);
        await processThread(neynarCastToCast(parentCast));
      }
    }

    await processThread(cast);
    return thread;
  }

  private async handleMentionCast({
    agent,
    mention,
    cast,
  }: {
    agent: Profile;
    cast: NeynarCast;
    mention: Cast;
  }): Promise<void> {
    if (mention.profile.fid === agent.fid) {
      this.runtime.logger.info({ hash: mention.hash }, "skipping cast from bot itself");
      return;
    }

    const memory = await this.ensureCastConnection(mention);
    await this.buildThreadForCast(mention, memory.id ? new Set([memory.id]) : new Set());

    if (!memory.content.text || memory.content.text.trim() === "") {
      this.runtime.logger.info({ hash: mention.hash }, "skipping cast with no text");
      return;
    }

    const callback = standardCastHandlerCallback({
      client: this.client,
      runtime: this.runtime,
      config: this.config,
      roomId: memory.roomId,
      inReplyTo: {
        hash: mention.hash,
        fid: mention.authorFid,
      },
    });

    try {
      if (!this.runtime.messageService) {
        this.runtime.logger.warn(
          "[Farcaster] messageService not available, skipping mention handling"
        );
        return;
      }
      await this.runtime.messageService.handleMessage(this.runtime, memory, callback);
    } catch (error) {
      this.runtime.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          castHash: mention.hash,
        },
        "[Farcaster] Error processing mention"
      );
    }

    const mentionPayload: FarcasterGenericCastPayload = {
      runtime: this.runtime,
      memory,
      cast,
      source: FARCASTER_SOURCE,
      callback,
    };
    this.runtime.emitEvent(FarcasterEventTypes.MENTION_RECEIVED, mentionPayload);
  }

  async start(): Promise<void> {
    this.runtime.logger.info(`Starting Farcaster interaction manager in ${this.mode} mode`);
    await this.source.start();
  }

  async stop(): Promise<void> {
    this.runtime.logger.info("Stopping Farcaster interaction manager");
    await this.source.stop();
  }
}

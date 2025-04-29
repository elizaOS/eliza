import {
  ChannelType,
  composePrompt,
  Content,
  createUniqueUuid,
  EventType,
  type IAgentRuntime,
  logger,
  type Memory,
  MessagePayload,
  ModelType,
  UUID,
} from '@elizaos/core';
import { CastWithInteractions } from '@neynar/nodejs-sdk/build/api';
import type { FarcasterClient } from '../client';
import { AsyncQueue } from '../common/asyncqueue';
import { standardCastHandlerCallback } from '../common/callbacks';
import { FARCASTER_SOURCE } from '../common/constants';
import { formatCast, formatTimeline } from '../common/prompts';
import { shouldRespondTemplate } from '@elizaos/core';
import {
  type Cast,
  type FarcasterConfig,
  FarcasterEventTypes,
  FarcasterGenericCastPayload,
  type Profile,
} from '../common/types';
import { castUuid, formatCastTimestamp, neynarCastToCast } from '../common/utils';
interface FarcasterInteractionParams {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
}

export class FarcasterInteractionManager {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private isRunning: boolean = false;
  private client: FarcasterClient;
  private runtime: IAgentRuntime;
  private config: FarcasterConfig;

  private asyncQueue: AsyncQueue;

  constructor(opts: FarcasterInteractionParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.asyncQueue = new AsyncQueue(1);
  }

  public async start(): Promise<void> {
    logger.info('Starting Farcaster interactions');
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // never await this, it will block forever
    void this.runPeriodically();
  }

  public async stop(): Promise<void> {
    if (this.timeout) clearTimeout(this.timeout);
    this.isRunning = false;
  }

  private async runPeriodically(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.handleInteractions();

        // now sleep for the configured interval
        const delay = this.config.FARCASTER_POLL_INTERVAL * 1000;
        await new Promise((resolve) => (this.timeout = setTimeout(resolve, delay)));
      } catch (error) {
        logger.error('[Farcaster] Error in periodic interactions:', this.runtime.agentId, error);
      }
    }
  }

  private async ensureCastConnection(cast: Cast): Promise<Memory> {
    return await this.asyncQueue.submit(async () => {
      const memoryId = castUuid({ agentId: this.runtime.agentId, hash: cast.hash });
      const conversationId = cast.threadId ?? cast.inReplyTo?.hash ?? cast.hash;
      const entityId = createUniqueUuid(this.runtime, cast.authorFid.toString());
      const worldId = createUniqueUuid(this.runtime, cast.authorFid.toString());
      const serverId = cast.authorFid.toString();
      const roomId = createUniqueUuid(this.runtime, conversationId);

      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${cast.profile.username}'s Farcaster`,
        agentId: this.runtime.agentId,
        serverId,
        metadata: {
          ownership: { ownerId: cast.authorFid.toString() },
          farcaster: {
            username: cast.profile.username,
            id: cast.authorFid.toString(),
            name: cast.profile.name,
          },
        },
      });

      // Ensure thread room exists
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `Thread with ${cast.profile.name ?? cast.profile.username}`,
        source: FARCASTER_SOURCE,
        type: ChannelType.THREAD,
        channelId: conversationId,
        serverId,
        worldId,
      });

      if (entityId !== this.runtime.agentId) {
        await this.runtime.ensureConnection({
          entityId,
          roomId,
          userName: cast.profile.username,
          name: cast.profile.name,
          source: FARCASTER_SOURCE,
          type: ChannelType.THREAD,
          channelId: conversationId,
          serverId,
          worldId,
        });
      }

      const memory: Memory = {
        id: memoryId,
        agentId: this.runtime.agentId,
        content: {
          text: cast.text,
          // need to pull imageUrls
          inReplyTo: cast.inReplyTo?.hash
            ? castUuid({ agentId: this.runtime.agentId, hash: cast.inReplyTo.hash })
            : undefined,
          source: FARCASTER_SOURCE,
          channelType: ChannelType.THREAD,
        },
        entityId,
        roomId,
        createdAt: cast.timestamp.getTime(),
      };

      // no need to store the memory as it'll be stored in bootstrap side

      return memory;
    });
  }

  private async handleInteractions(): Promise<void> {
    const agentFid = this.config.FARCASTER_FID;
    const [mentions, agent] = await Promise.all([
      this.client.getMentions({
        fid: agentFid,
        pageSize: 20,
      }),
      this.client.getProfile(agentFid),
    ]);

    for (const cast of mentions) {
      const mention = neynarCastToCast(cast);
      const memoryId = castUuid({ agentId: this.runtime.agentId, hash: mention.hash });

      if (await this.runtime.getMemoryById(memoryId)) {
        continue;
      }

      logger.info('New Cast found', mention.hash);

      // filter out the agent mentions
      if (mention.authorFid === agentFid) {
        const memory = await this.ensureCastConnection(mention);
        await this.runtime.addEmbeddingToMemory(memory);
        await this.runtime.createMemory(memory, 'messages');
        continue;
      }

      await this.handleMentionCast({ agent, mention, cast });
    }
  }

  async buildThreadForCast(cast: Cast, skipMemoryId: Set<UUID>): Promise<Cast[]> {
    const thread: Cast[] = [];
    const visited: Set<string> = new Set();
    const client = this.client;
    const runtime = this.runtime;
    const self = this;

    async function processThread(currentCast: Cast) {
      const memoryId = castUuid({ hash: currentCast.hash, agentId: runtime.agentId });

      if (visited.has(currentCast.hash) || skipMemoryId.has(memoryId)) {
        return;
      }

      visited.add(currentCast.hash);

      // Check if the current cast has already been saved
      const memory = await runtime.getMemoryById(memoryId);

      if (!memory) {
        logger.info('Creating memory for cast', currentCast.hash);
        const memory = await self.ensureCastConnection(currentCast);
        await runtime.createMemory(memory, 'messages');
        runtime.emitEvent(FarcasterEventTypes.THREAD_CAST_CREATED, {
          runtime,
          memory,
          cast: currentCast,
          source: FARCASTER_SOURCE,
        });
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
    cast: CastWithInteractions;
    mention: Cast;
  }): Promise<void> {
    if (mention.profile.fid === agent.fid) {
      logger.info('skipping cast from bot itself', mention.hash);
      return;
    }

    // Process one at a time to ensure proper sequencing
    const memory = await this.ensureCastConnection(mention);
    const thread: Cast[] = await this.buildThreadForCast(
      mention,
      memory.id ? new Set([memory.id]) : new Set()
    );

    if (!memory.content.text || memory.content.text.trim() === '') {
      logger.info('skipping cast with no text', mention.hash);
      return;
    }

    // Build the state for the prompt
    const currentPost = formatCast(mention);
    const { timeline } = await this.client.getTimeline({ fid: agent.fid, pageSize: 20 });
    const formattedTimeline = formatTimeline(this.runtime.character, timeline);
    const formattedConversation = thread
      .map((c) =>
        `
        - @${c.profile.username} (${formatCastTimestamp(c.timestamp)}):
          ${c.text}`.trim()
      )
      .join('\n\n');

    const state = await this.runtime.composeState(memory);
    state.values = {
      ...state.values,
      farcasterUsername: agent.username,
      timeline: formattedTimeline,
      currentPost,
      formattedConversation,
    };

    // Determine if we should respond to the cast
    const shouldRespondPrompt = composePrompt({
      state,
      template:
        this.runtime.character.templates?.farcasterShouldRespondTemplate ||
        this.runtime.character?.templates?.shouldRespondTemplate ||
        shouldRespondTemplate,
    });

    const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: shouldRespondPrompt,
    });

    const responseActions = (response.match(/(?:RESPOND|IGNORE|STOP)/g) || ['IGNORE'])[0];
    if (responseActions !== 'RESPOND') {
      logger.info(`Not responding to cast based on shouldRespond decision: ${responseActions}`);
      try {
        // save the memory so we don't process it again in mentions
        await this.runtime.createMemory(memory, 'messages');
      } catch (error) {
        logger.error('Error creating ignoredmemory', error);
      }
      return;
    }

    // setup callback for the response
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

    // Emit generic message received events
    const messageReceivedPayload: MessagePayload = {
      runtime: this.runtime,
      message: memory,
      source: FARCASTER_SOURCE,
      callback,
    };

    this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, messageReceivedPayload);

    // Emit platform-specific MENTION_RECEIVED event
    const mentionPayload: FarcasterGenericCastPayload = {
      runtime: this.runtime,
      memory,
      cast,
      source: FARCASTER_SOURCE,
      callback: async (ontent: Content, _files: any[]) => {
        logger.info('[Farcaster] mention received response:', response);
        return [];
      },
    };
    this.runtime.emitEvent(FarcasterEventTypes.MENTION_RECEIVED, mentionPayload);
  }
}

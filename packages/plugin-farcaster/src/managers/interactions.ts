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
} from '@elizaos/core';
import { CastWithInteractions } from '@neynar/nodejs-sdk/build/api';
import type { FarcasterClient } from '../client';
import { standardCastHandlerCallback } from '../common/callbacks';
import { FARCASTER_SOURCE } from '../common/constants';
import { formatCast, formatTimeline, shouldRespondTemplate } from '../common/prompts';
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

  constructor(opts: FarcasterInteractionParams) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
  }

  public async start(): Promise<void> {
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

  private async ensureCast(cast: Cast): Promise<Memory> {
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

      logger.log('New Cast found', mention.hash);

      // filter out the agent mentions
      if (mention.authorFid === agentFid) {
        const memory = await this.ensureCast(mention);
        await this.runtime.addEmbeddingToMemory(memory);
        await this.runtime.createMemory(memory, 'messages');
        continue;
      }

      await this.handleMentionCast({ agent, mention, cast });
    }
  }

  async buildThreadForCast(cast: Cast): Promise<Cast[]> {
    const thread: Cast[] = [];
    const visited: Set<string> = new Set();
    const client = this.client;
    const runtime = this.runtime;
    const self = this;

    async function processThread(currentCast: Cast) {
      if (visited.has(currentCast.hash)) {
        return;
      }

      visited.add(currentCast.hash);

      // Check if the current cast has already been saved
      const memoryId = castUuid({ hash: currentCast.hash, agentId: runtime.agentId });
      const memory = await runtime.getMemoryById(memoryId);

      if (!memory) {
        logger.log('Creating memory for cast', currentCast.hash);
        const memory = await self.ensureCast(currentCast);
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
      logger.log('skipping cast from bot itself', mention.hash);
      return;
    }

    const [memory, thread] = await Promise.all([
      this.ensureCast(mention),
      this.buildThreadForCast(mention),
    ]);

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
      logger.log(`Not responding to cast based on shouldRespond decision: ${responseActions}`);
      return;
    }

    // setup callback for the response
    const callback = standardCastHandlerCallback({
      client: this.client,
      runtime: this.runtime,
      config: this.config,
      roomId: memory.roomId,
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

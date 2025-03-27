import {
  type Memory,
  stringToUuid,
  elizaLogger,
  type HandlerCallback,
  type Content,
  type IAgentRuntime,
  logger,
  createUniqueUuid,
  ChannelType,
} from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { createCastMemory } from '../memory';
import type { Cast, FarcasterConfig, Profile } from '../common/types';
import {
  formatCast,
  formatTimeline,
  messageHandlerTemplate,
  shouldRespondTemplate,
} from '../common/prompts';
import { castUuid } from '../common/utils';
import { sendCast } from '../actions';
import { FARCASTER_SOURCE } from '../common/constants';

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

  public async start() {
    if (this.isRunning) {
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

  private async handleInteractions() {
    const agentFid = this.config.FARCASTER_FID;
    const mentions = await this.client.getMentions({
      fid: agentFid,
      pageSize: 30,
    });

    const agent = await this.client.getProfile(agentFid);
    for (const mention of mentions) {
      const messageHash = mention.hash;
      const castId = castUuid({ agentId: this.runtime.agentId, hash: mention.hash });

      const pastMemory = await this.runtime.getMemoryById(castId);

      if (pastMemory) {
        continue;
      }

      logger.log('New Cast found', messageHash);

      const entityId = createUniqueUuid(
        this.runtime,
        mention.authorFid === agentFid ? this.runtime.agentId : mention.authorFid.toString()
      );
      const worldId = createUniqueUuid(this.runtime, mention.authorFid.toString());
      const serverId = mention.authorFid.toString();
      const roomId = createUniqueUuid(this.runtime, mention.threadId ?? mention.hash);

      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${mention.profile.username}'s Farcaster`,
        agentId: this.runtime.agentId,
        serverId,
        metadata: {
          ownership: { ownerId: mention.authorFid.toString() },
          farcaster: {
            username: mention.profile.username,
            id: mention.authorFid.toString(),
            name: mention.profile.name,
          },
        },
      });

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: mention.profile.username,
        name: mention.profile.name,
        source: FARCASTER_SOURCE,
        type: ChannelType.GROUP,
        channelId: messageHash,
        serverId,
        worldId,
      });

      // Ensure conversation room exists
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `Conversation with ${mention.profile.name ?? mention.profile.username}`,
        source: FARCASTER_SOURCE,
        type: ChannelType.GROUP,
        channelId: messageHash,
        serverId,
        worldId,
      });

      // const thread = await buildConversationThread({
      //   client: this.client,
      //   runtime: this.runtime,
      //   cast: mention,
      // });

      const memory: Memory = {
        agentId: this.runtime.agentId,
        content: {
          text: mention.text,
          // need to pull imageUrls
          inReplyTo: mention.inReplyTo?.hash
            ? castUuid({ agentId: this.runtime.agentId, hash: mention.inReplyTo.hash })
            : undefined,
          source: FARCASTER_SOURCE,
          channelType: ChannelType.GROUP,
        },
        entityId,
        roomId,
        createdAt: mention.timestamp.getTime(),
      };

      // FIXME: emit

      // await this.handleCast({
      //   agent,
      //   cast: mention,
      //   memory,
      //   thread,
      // });
    }
  }

  private async handleCast({
    agent,
    cast,
    memory,
    thread,
  }: {
    agent: Profile;
    cast: Cast;
    memory: Memory;
    thread: Cast[];
  }) {
    if (cast.profile.fid === agent.fid) {
      elizaLogger.info('skipping cast from bot itself', cast.hash);
      return;
    }

    if (!memory.content.text) {
      elizaLogger.info('skipping cast with no text', cast.hash);
      return { text: '', action: 'IGNORE' };
    }

    const currentPost = formatCast(cast);

    const senderId = stringToUuid(cast.authorFid.toString());

    const { timeline } = await this.client.getTimeline({
      fid: agent.fid,
      pageSize: 10,
    });

    const formattedTimeline = formatTimeline(this.runtime.character, timeline);

    const formattedConversation = thread
      .map(
        (cast) => `@${cast.profile.username} (${new Date(cast.timestamp).toLocaleString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          month: 'short',
          day: 'numeric',
        })}):
                ${cast.text}`
      )
      .join('\n\n');

    const state = await this.runtime.composeState(memory, {
      farcasterUsername: agent.username,
      timeline: formattedTimeline,
      currentPost,
      formattedConversation,
    });

    const shouldRespondContext = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterShouldRespondTemplate ||
        this.runtime.character?.templates?.shouldRespondTemplate ||
        shouldRespondTemplate,
    });

    const memoryId = castUuid({
      agentId: this.runtime.agentId,
      hash: cast.hash,
    });

    const castMemory = await this.runtime.getMemoryById(memoryId);

    if (!castMemory) {
      await this.runtime.createMemory(
        createCastMemory({
          roomId: memory.roomId,
          senderId,
          runtime: this.runtime,
          cast,
        }),
        'messages'
      );
    }

    const shouldRespondResponse = await generateShouldRespond({
      runtime: this.runtime,
      context: shouldRespondContext,
      modelClass: ModelClass.SMALL,
    });

    if (shouldRespondResponse === 'IGNORE' || shouldRespondResponse === 'STOP') {
      elizaLogger.info(
        `Not responding to cast because generated ShouldRespond was ${shouldRespondResponse}`
      );
      return;
    }

    const context = composeContext({
      state,
      template:
        this.runtime.character.templates?.farcasterMessageHandlerTemplate ??
        this.runtime.character?.templates?.messageHandlerTemplate ??
        messageHandlerTemplate,
    });

    const responseContent = await generateMessageResponse({
      runtime: this.runtime,
      context,
      modelClass: ModelClass.LARGE,
    });

    responseContent.inReplyTo = memoryId;

    if (!responseContent.text) return;

    if (this.client.farcasterConfig?.FARCASTER_DRY_RUN) {
      elizaLogger.info(
        `Dry run: would have responded to cast ${cast.hash} with ${responseContent.text}`
      );
      return;
    }

    const callback: HandlerCallback = async (content: Content, _files: any[]) => {
      try {
        if (memoryId && !content.inReplyTo) {
          content.inReplyTo = memoryId;
        }
        const results = await sendCast({
          runtime: this.runtime,
          client: this.client,
          signerUuid: this.signerUuid,
          profile: cast.profile,
          content: content,
          roomId: memory.roomId,
          inReplyTo: {
            fid: cast.authorFid,
            hash: cast.hash,
          },
        });

        // no casts were sent, so we need to return an empty array
        if (results.length === 0) {
          return [];
        }

        // sendCast lost response action, so we need to add it back here
        results[0].memory.content.action = content.action;

        for (const { memory } of results) {
          await this.runtime.createMemory(memory, 'messages');
        }
        return results.map((result) => result.memory);
      } catch (error) {
        elizaLogger.error('Error sending response cast:', error);
        return [];
      }
    };

    const responseMessages = await callback(responseContent);

    const newState = await this.runtime.updateRecentMessageState(state);

    await this.runtime.processActions(
      { ...memory, content: { ...memory.content, cast } },
      responseMessages,
      newState,
      callback
    );
  }
}

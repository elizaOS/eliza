import { type IAgentRuntime, stringToUuid, logger, ChannelType, elizaLogger } from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { formatTimeline, postTemplate } from '../common/prompts';
import { castUuid, lastCastCacheKey, MAX_CAST_LENGTH } from '../common/utils';
import { createCastMemory } from '../memory';
import { sendCast } from '../actions';
import { FarcasterConfig, LastCast } from '../common/types';
import { FARCASTER_SOURCE } from '../common/constants';

export class FarcasterPostManager {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  fid: number;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  // FIXME: hish - remove this and use runtime cache
  private cache = new Map<string, any>();

  private config: FarcasterConfig;

  constructor(opts: { client: FarcasterClient; runtime: IAgentRuntime; config: FarcasterConfig }) {
    this.client = opts.client;
    this.runtime = opts.runtime;
    this.config = opts.config;
    this.fid = this.config.FARCASTER_FID;
  }

  public async start() {
    const generateNewCastLoop = async () => {
      const lastPost = await this.runtime.getCache<LastCast>(lastCastCacheKey(this.fid));

      const lastPostTimestamp = lastPost?.timestamp ?? 0;
      const minMinutes = this.config.POST_INTERVAL_MIN;
      const maxMinutes = this.config.POST_INTERVAL_MAX;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1000;

      if (Date.now() > lastPostTimestamp + delay) {
        try {
          await this.generateNewCast();
        } catch (error) {
          logger.error(error);
          return;
        }
      }

      this.timeout = setTimeout(() => {
        generateNewCastLoop(); // Set up next iteration
      }, delay);

      logger.log(`Next cast scheduled in ${randomMinutes} minutes`);
    };

    if (this.config.ENABLE_POST) {
      if (this.config.POST_IMMEDIATELY) {
        await this.generateNewCast();
      } else {
        generateNewCastLoop();
      }
    }
  }

  public async stop() {
    if (this.timeout) clearTimeout(this.timeout);
  }

  private async generateNewCast() {
    logger.info('Generating new cast');
    try {
      const profile = await this.client.getProfile(this.fid);
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        profile.username,
        this.runtime.character.name,
        'farcaster'
      );

      const { timeline } = await this.client.getTimeline({
        fid: this.fid,
        pageSize: 10,
      });

      this.cache.set('farcaster/timeline', timeline);

      const formattedHomeTimeline = formatTimeline(this.runtime.character, timeline);

      const generateRoomId = stringToUuid('farcaster_generate_room');

      const state = await this.runtime.composeState(
        {
          roomId: generateRoomId,
          userId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          content: { text: '', action: '' },
        },
        {
          farcasterUserName: profile.username,
          timeline: formattedHomeTimeline,
        }
      );

      // Generate new cast
      const context = composeContext({
        state,
        template: this.runtime.character.templates?.farcasterPostTemplate || postTemplate,
      });

      const newContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      const slice = newContent.replaceAll(/\\n/g, '\n').trim();

      let content = slice.slice(0, MAX_CAST_LENGTH);

      // if it's bigger than the max limit, delete the last line
      if (content.length > MAX_CAST_LENGTH) {
        content = content.slice(0, content.lastIndexOf('\n'));
      }

      if (content.length > MAX_CAST_LENGTH) {
        // slice at the last period
        content = content.slice(0, content.lastIndexOf('.'));
      }

      // if it's still too long, get the period before the last period
      if (content.length > MAX_CAST_LENGTH) {
        content = content.slice(0, content.lastIndexOf('.'));
      }

      if (this.runtime.getSetting('FARCASTER_DRY_RUN') === 'true') {
        logger.info(`Dry run: would have cast: ${content}`);
        return;
      }

      try {
        const castsPosted = await sendCast({
          client: this.client,
          runtime: this.runtime,
          roomId: generateRoomId,
          content: { text: content },
          profile,
        });

        if (castsPosted.length === 0) {
          logger.warn('No casts posted');
          return;
        }

        const [{ cast }] = castsPosted;

        await this.runtime.setCache<LastCast>(lastCastCacheKey(this.fid), {
          hash: cast.hash,
          timestamp: Date.now(),
        });

        const roomId = castUuid({
          agentId: this.runtime.agentId,
          hash: cast.hash,
        });

        await this.runtime.ensureRoomExists({
          id: roomId,
          name: 'Farcaster Feed',
          source: FARCASTER_SOURCE,
          type: ChannelType.FEED,
        });

        await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);

        logger.info(`[Farcaster Neynar Client] Published cast ${cast.hash}`);

        await this.runtime.createMemory(
          createCastMemory({
            roomId,
            senderId: this.runtime.agentId,
            runtime: this.runtime,
            cast,
          }),
          'messages'
        );
      } catch (error) {
        logger.error('Error sending cast:', error);
      }
    } catch (error) {
      logger.error('Error generating new cast:', error);
    }
  }
}

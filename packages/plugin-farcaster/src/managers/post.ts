import { type IAgentRuntime, stringToUuid, elizaLogger, ChannelType } from '@elizaos/core';
import type { FarcasterClient } from '../client';
import { formatTimeline, postTemplate } from '../common/prompts';
import { castUuid, lastCastCacheKey, MAX_CAST_LENGTH } from '../common/utils';
import { createCastMemory } from '../memory';
import { sendCast } from '../actions';
import { LastCast } from '../common/types';
import { FARCASTER_SOURCE } from '../common/constants';

export class FarcasterPostManager {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  fid: number;
  isDryRun: boolean;
  private timeout: NodeJS.Timeout | undefined;

  constructor(
    client: FarcasterClient,
    runtime: IAgentRuntime,
    private signerUuid: string,
    public cache: Map<string, any>
  ) {
    this.client = client;
    this.runtime = runtime;

    this.fid = this.client.farcasterConfig?.FARCASTER_FID ?? 0;
    this.isDryRun = this.client.farcasterConfig?.FARCASTER_DRY_RUN ?? false;

    // Log configuration on initialization
    elizaLogger.log('Farcaster Client Configuration:');
    elizaLogger.log(`- FID: ${this.fid}`);
    elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? 'enabled' : 'disabled'}`);
    elizaLogger.log(
      `- Enable Post: ${this.client.farcasterConfig.ENABLE_POST ? 'enabled' : 'disabled'}`
    );
    if (this.client.farcasterConfig.ENABLE_POST) {
      elizaLogger.log(
        `- Post Interval: ${this.client.farcasterConfig.POST_INTERVAL_MIN}-${this.client.farcasterConfig.POST_INTERVAL_MAX} minutes`
      );
      elizaLogger.log(
        `- Post Immediately: ${this.client.farcasterConfig.POST_IMMEDIATELY ? 'enabled' : 'disabled'}`
      );
    }
    elizaLogger.log(
      `- Action Processing: ${this.client.farcasterConfig.ENABLE_ACTION_PROCESSING ? 'enabled' : 'disabled'}`
    );
    elizaLogger.log(`- Action Interval: ${this.client.farcasterConfig.ACTION_INTERVAL} minutes`);

    if (this.isDryRun) {
      elizaLogger.log(
        'Farcaster client initialized in dry run mode - no actual casts should be posted'
      );
    }
  }

  public async start() {
    const generateNewCastLoop = async () => {
      const lastPost = await this.runtime.getCache<LastCast>(lastCastCacheKey(this.fid));

      const lastPostTimestamp = lastPost?.timestamp ?? 0;
      const minMinutes = this.client.farcasterConfig.POST_INTERVAL_MIN;
      const maxMinutes = this.client.farcasterConfig.POST_INTERVAL_MAX;
      const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1000;

      if (Date.now() > lastPostTimestamp + delay) {
        try {
          await this.generateNewCast();
        } catch (error) {
          elizaLogger.error(error);
          return;
        }
      }

      this.timeout = setTimeout(() => {
        generateNewCastLoop(); // Set up next iteration
      }, delay);

      elizaLogger.log(`Next cast scheduled in ${randomMinutes} minutes`);
    };

    if (this.client.farcasterConfig.ENABLE_POST) {
      if (this.client.farcasterConfig.POST_IMMEDIATELY) {
        await this.generateNewCast();
      }
      generateNewCastLoop();
    }
  }

  public async stop() {
    if (this.timeout) clearTimeout(this.timeout);
  }

  private async generateNewCast() {
    elizaLogger.info('Generating new cast');
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
        elizaLogger.info(`Dry run: would have cast: ${content}`);
        return;
      }

      try {
        const castsPosted = await sendCast({
          client: this.client,
          runtime: this.runtime,
          signerUuid: this.signerUuid,
          roomId: generateRoomId,
          content: { text: content },
          profile,
        });

        if (castsPosted.length === 0) {
          elizaLogger.warn('No casts posted');
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

        elizaLogger.info(`[Farcaster Neynar Client] Published cast ${cast.hash}`);

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
        elizaLogger.error('Error sending cast:', error);
      }
    } catch (error) {
      elizaLogger.error('Error generating new cast:', error);
    }
  }
}

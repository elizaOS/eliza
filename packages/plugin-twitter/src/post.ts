import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
  parseBooleanFromText,
} from '@elizaos/core';
import type { ClientBase } from './base';
import type { MediaData } from './types';
import { TwitterEventTypes } from './types';
import { sendTweet } from './utils';
/**
 * Class representing a Twitter post client for generating and posting tweets.
 */
export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  private isDryRun: boolean;
  private state: any;

  /**
   * Constructor for initializing a new Twitter client with the provided client, runtime, and state
   * @param {ClientBase} client - The client used for interacting with Twitter API
   * @param {IAgentRuntime} runtime - The runtime environment for the agent
   * @param {any} state - The state object containing configuration settings
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.state = state;
    this.runtime = runtime;
    this.twitterUsername =
      state?.TWITTER_USERNAME || (this.runtime.getSetting('TWITTER_USERNAME') as string);
    this.isDryRun =
      this.state?.TWITTER_DRY_RUN ||
      (this.runtime.getSetting('TWITTER_DRY_RUN') as unknown as boolean);

    // Log configuration on initialization
    logger.log('Twitter Client Configuration:');
    logger.log(`- Username: ${this.twitterUsername}`);
    logger.log(`- Dry Run Mode: ${this.isDryRun ? 'Enabled' : 'Disabled'}`);

    this.state.isTwitterEnabled = parseBooleanFromText(
      String(
        this.state?.TWITTER_ENABLE_POST_GENERATION ||
          this.runtime.getSetting('TWITTER_ENABLE_POST_GENERATION') ||
          ''
      )
    );

    logger.log(`- Auto-post: ${this.state.isTwitterEnabled ? 'enabled' : 'disabled'}`);

    logger.log(
      `- Post Interval: ${this.state?.TWITTER_POST_INTERVAL_MIN || this.runtime.getSetting('TWITTER_POST_INTERVAL_MIN')}-${this.state?.TWITTER_POST_INTERVAL_MAX || this.runtime.getSetting('TWITTER_POST_INTERVAL_MAX')} minutes`
    );
    logger.log(
      `- Post Immediately: ${
        this.state?.TWITTER_POST_IMMEDIATELY || this.runtime.getSetting('TWITTER_POST_IMMEDIATELY')
          ? 'enabled'
          : 'disabled'
      }`
    );

    if (this.isDryRun) {
      logger.log('Twitter client initialized in dry run mode - no actual tweets should be posted');
    }
  }

  /**
   * Starts the Twitter post client, setting up a loop to periodically generate new tweets.
   */
  async start() {
    logger.log('Starting Twitter post client...');
    const tweetGeneration = this.state.isTwitterEnabled;
    if (tweetGeneration === false) {
      logger.log('Tweet generation is disabled');
      return;
    }

    const generateNewTweetLoop = async () => {
      // Defaults to 30 minutes
      const interval =
        (this.state?.TWITTER_POST_INTERVAL ||
          (this.runtime.getSetting('TWITTER_POST_INTERVAL') as unknown as number) ||
          30) *
        60 *
        1000;

      this.generateNewTweet();
      setTimeout(generateNewTweetLoop, interval);
    };

    // Start the loop after a 1 minute delay to allow other services to initialize
    setTimeout(generateNewTweetLoop, 60 * 1000);
    if (this.runtime.getSetting('TWITTER_POST_IMMEDIATELY')) {
      // await 1 second
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.generateNewTweet();
    }
  }

  /**
   * Handles the creation and posting of a tweet by emitting standardized events.
   * This approach aligns with our platform-independent architecture.
   */
  async generateNewTweet() {
    try {
      // Create the timeline room ID for storing the post
      const userId = this.client.profile?.id;
      if (!userId) {
        logger.error('Cannot generate tweet: Twitter profile not available');
        return;
      }

      // Create standardized world and room IDs
      const worldId = createUniqueUuid(this.runtime, userId) as UUID;
      const roomId = createUniqueUuid(this.runtime, `${userId}-home`) as UUID;
      // Create a callback for handling the actual posting
      const callback: HandlerCallback = async (content: Content) => {
        try {
          if (this.isDryRun) {
            logger.info(`[DRY RUN] Would post tweet: ${content.text}`);
            return [];
          }

          if (content.text.includes('Error: Missing')) {
            logger.error('Error: Missing some context', content);
            return [];
          }

          // Post the tweet
          const result = await this.postToTwitter(content.text, content.mediaData as MediaData[]);

          // If result is null, it means we detected a duplicate tweet and skipped posting
          if (result === null) {
            logger.info('Skipped posting duplicate tweet');
            return [];
          }

          const tweetId =
            (result as any).rest_id || (result as any).id_str || (result as any).legacy?.id_str;

          if (result) {
            const postedTweetId = createUniqueUuid(this.runtime, tweetId);

            // Create memory for the posted tweet
            const postedMemory: Memory = {
              id: postedTweetId,
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              roomId,
              content: {
                ...content,
                source: 'twitter',
                channelType: ChannelType.FEED,
                type: 'post',
                metadata: {
                  tweetId,
                  postedAt: Date.now(),
                },
              },
              createdAt: Date.now(),
            };

            await this.runtime.createMemory(postedMemory, 'messages');

            return [postedMemory];
          }

          return [];
        } catch (error) {
          logger.error('Error posting tweet:', error, content);
          return [];
        }
      };

      // Emit event to handle the post generation using standard handlers
      this.runtime.emitEvent([EventType.POST_GENERATED, TwitterEventTypes.POST_GENERATED], {
        runtime: this.runtime,
        callback,
        worldId,
        userId,
        roomId,
        source: 'twitter',
      });
    } catch (error) {
      logger.error('Error generating tweet:', error);
    }
  }

  /**
   * Posts content to Twitter
   * @param {string} text The tweet text to post
   * @param {MediaData[]} mediaData Optional media to attach to the tweet
   * @returns {Promise<any>} The result from the Twitter API
   */
  private async postToTwitter(text: string, mediaData: MediaData[] = []): Promise<any> {
    try {
      // Check if this tweet is a duplicate of the last one
      const lastPost = await this.runtime.getCache<any>(
        `twitter/${this.client.profile?.username}/lastPost`
      );
      if (lastPost) {
        // Fetch the last tweet to compare content
        const lastTweet = await this.client.getTweet(lastPost.id);
        if (lastTweet && lastTweet.text === text) {
          logger.warn('Tweet is a duplicate of the last post. Skipping to avoid duplicate.');
          return null;
        }
      }

      // Handle media uploads if needed
      const mediaIds: string[] = [];

      if (mediaData && mediaData.length > 0) {
        for (const media of mediaData) {
          try {
            // TODO: Media upload will need to be updated to use the new API
            // For now, just log a warning that media upload is not supported
            logger.warn('Media upload not currently supported with the modern Twitter API');
          } catch (error) {
            logger.error('Error uploading media:', error);
          }
        }
      }

      const result = await sendTweet(this.client, text, mediaData);

      if (!result) {
        logger.error('Error sending tweet; Bad response:');
        return null;
      }

      return result;
    } catch (error) {
      logger.error('Error posting to Twitter:', error);
      throw error;
    }
  }

  async stop() {
    // Implement stop functionality if needed
  }
}

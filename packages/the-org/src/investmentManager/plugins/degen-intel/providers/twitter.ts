// todo: replace Client reference with client reference
// Set up cache adapter for loading cookies
// This action should be able to run on a schedule
// store tweets as memories in db, no reason really to get twitter here

import {
  ChannelType,
  type IAgentRuntime,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
const TWITTER_SERVICE = 'twitter';

export default class Twitter {
  runtime: IAgentRuntime;
  feedRoomId: UUID;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    // Create a consistent room ID for the twitter feed
    this.feedRoomId = createUniqueUuid(runtime, 'twitter-feed');
  }

  async syncRawTweets(): Promise<boolean> {
    const username = this.runtime.getSetting('TWITTER_USERNAME');

    // Ensure feed room exists
    await this.runtime.ensureRoomExists({
      id: this.feedRoomId,
      name: 'Twitter Feed',
      source: 'twitter',
      type: ChannelType.FEED,
    });

    // get the twitterClient from runtime
    const twitterClient = this.runtime.getService(TWITTER_SERVICE) as any;
    if (!twitterClient) {
      logger.error('Twitter client not found');
      return false;
    }

    try {
      const list = twitterClient.getTweets(username as string, 200);
      let syncCount = 0;

      for await (const item of list) {
        if (item?.text && !item?.isRetweet) {
          const tweetId = createUniqueUuid(this.runtime, item.id);

          // Check if we already have this tweet
          const existingTweet = await this.runtime.getMemoryById(tweetId);
          if (existingTweet) {
            continue;
          }

          // Create memory for the tweet
          await this.runtime.createMemory(
            {
              id: tweetId,
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              content: {
                text: item.text,
                source: 'twitter',
                metadata: {
                  likes: item.likes ?? 0,
                  retweets: item.retweets ?? 0,
                  username: item.username,
                  timestamp: new Date(item.timestamp * 1000).toISOString(),
                },
              },
              roomId: this.feedRoomId,
              createdAt: item.timestamp * 1000,
            },
            'messages'
          );

          syncCount++;
        }
      }

      logger.info(`Raw tweet sync [username: ${username}] synced ${syncCount} new tweets`);

      /** Sleep 10 seconds */
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      return true;
    } catch (error) {
      logger.error('Error syncing tweets:', error);
      return false;
    }
  }
}

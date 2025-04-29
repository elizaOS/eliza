// todo: replace Client reference with client reference
// Set up cache adapter for loading cookies
// This action should be able to run on a schedule
// store tweets as memories in db, no reason really to get twitter here

import {
  ChannelType,
  type IAgentRuntime,
  ServiceType,
  type UUID,
  createUniqueUuid,
  logger,
  stringToUuid,
  Service,
} from '@elizaos/core';

interface TwitterService extends Service {
  getClientKey(clientId: UUID, agentId: UUID): string;
  clients: Map<string, any>;
}

export default class Twitter {
  runtime: IAgentRuntime;
  feedRoomId: UUID;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    // Create a consistent room ID for the twitter feed
    this.feedRoomId = createUniqueUuid(runtime, 'twitter-feed');
  }

  async syncRawTweets(): Promise<boolean> {
    const users = [
      'shawmakesmagic',
      'aixbt_agent',
      '0x_nomAI',
      'mobyagent',
      'arok_vc',
      'finding_yeti',
      'ShardiB2',
      'dankvr',
      'elizaos',
      'autodotfun',
    ];
    //const username = this.runtime.getSetting('TWITTER_USERNAME');

    // Ensure feed room exists
    await this.runtime.ensureRoomExists({
      id: this.feedRoomId,
      name: 'Twitter Feed',
      source: 'twitter',
      type: ChannelType.FEED,
    });

    // Get the Twitter service from runtime
    let manager = this.runtime.getService(ServiceType.TWITTER) as TwitterService;
    while (!manager) {
      //console.log('Waiting for Twitter service...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      manager = this.runtime.getService(ServiceType.TWITTER) as TwitterService;
    }
    console.log('degen-intel: Twitter manager acquired, starting sync');

    const client = manager.getClient(this.runtime.agentId, this.runtime.agentId);
    // it's not client.client
    //console.log('client keys', Object.keys(client)) //[ "client", "post", "interaction", "service" ]
    //console.log('client.client keys', Object.keys(client.client)) // "lastCheckedTweetId", "temperature", "requestQueue", "callback", "runtime", "state", "twitterClient", "profile"

    // Get the Twitter client directly from the manager
    let twitterClient = client.client.twitterClient;
    if (!twitterClient) {
      logger.error('Twitter client not found');
      return false;
    }

    for (const u of users) {
      try {
        // fetches my tweets
        const list = twitterClient.getTweets(u as string, 200);
        // fetch my following feed
        //const list = twitterClient.fetchFollowingTimeline(200, []);
        let syncCount = 0;

        for await (const item of list) {
          if (item?.text && !item?.isRetweet) {
            const tweetId = createUniqueUuid(this.runtime, item.id);

            // Check if we already have this tweet
            const existingTweet = await this.runtime.getMemoryById(tweetId);
            if (existingTweet) {
              console.log('old tweet');
              continue;
            }
            console.log('new tweet', item);

            // Create memory for the tweet
            await this.runtime.createMemory(
              {
                id: tweetId,
                agentId: this.runtime.agentId,
                roomId: this.feedRoomId,
                entityId: this.runtime.agentId,
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
                createdAt: item.timestamp * 1000,
              },
              'messages'
            );

            syncCount++;
          }
        }

        logger.info(`Raw tweet sync [username: ${u}] synced ${syncCount} new tweets`);
        await new Promise((resolve) => setTimeout(resolve, 10_000)); // 10s delay
      } catch (error) {
        logger.error('Error syncing tweets:', error);
        await new Promise((resolve) => setTimeout(resolve, 10_000)); // 10s delay
      }
    }
    return true;
  }
}

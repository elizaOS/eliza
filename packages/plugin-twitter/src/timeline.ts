import type { ClientBase } from './base';
import {
  ChannelType,
  composePromptFromState,
  createUniqueUuid,
  ModelType,
  type IAgentRuntime,
  UUID,
  State,
  parseActionResponseFromText,
  type ActionResponse,
  EventType,
  MessagePayload,
  HandlerCallback,
  Content,
  Memory,
} from '@elizaos/core';
import type { Client, Tweet } from './client/index';
import { logger } from '@elizaos/core';
import type { Tweet as ClientTweet } from './client/tweets';

import { twitterActionTemplate } from './templates';

enum TIMELINE_TYPE {
  ForYou = 'foryou',
  Following = 'following',
}

export class TwitterTimelineClient {
  client: ClientBase;
  twitterClient: Client;
  runtime: IAgentRuntime;
  isDryRun: boolean;
  timelineType: TIMELINE_TYPE;
  private state: any;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;
    this.state = state;

    this.timelineType =
      this.state?.TWITTER_TIMELINE_TYPE || this.runtime.getSetting('TWITTER_TIMELINE_TYPE');
  }

  async start() {
    const handleTwitterTimelineLoop = () => {
      // Defaults to 2 minutes
      const interactionInterval =
        (this.state?.TWITTER_TIMELINE_INTERVAL ||
          (this.runtime.getSetting('TWITTER_TIMELINE_INTERVAL') as unknown as number) ||
          120) * 1000;

      this.handleTimeline();
      setTimeout(handleTwitterTimelineLoop, interactionInterval);
    };
    handleTwitterTimelineLoop();
  }

  async getTimeline(count: number): Promise<Tweet[]> {
    const twitterUsername = this.client.profile?.username;
    const homeTimeline =
      this.timelineType === TIMELINE_TYPE.Following
        ? await this.twitterClient.fetchFollowingTimeline(count, [])
        : await this.twitterClient.fetchHomeTimeline(count, []);

    return homeTimeline
      .map((tweet) => ({
        id: tweet.rest_id,
        name: tweet.core?.user_results?.result?.legacy?.name,
        username: tweet.core?.user_results?.result?.legacy?.screen_name,
        text: tweet.legacy?.full_text,
        inReplyToStatusId: tweet.legacy?.in_reply_to_status_id_str,
        timestamp: new Date(tweet.legacy?.created_at).getTime() / 1000,
        userId: tweet.legacy?.user_id_str,
        conversationId: tweet.legacy?.conversation_id_str,
        permanentUrl: `https://twitter.com/${tweet.core?.user_results?.result?.legacy?.screen_name}/status/${tweet.rest_id}`,
        hashtags: tweet.legacy?.entities?.hashtags || [],
        mentions: tweet.legacy?.entities?.user_mentions || [],
        photos:
          tweet.legacy?.entities?.media
            ?.filter((media) => media.type === 'photo')
            .map((media) => ({
              id: media.id_str,
              url: media.media_url_https, // Store media_url_https as url
              alt_text: media.alt_text,
            })) || [],
        thread: tweet.thread || [],
        urls: tweet.legacy?.entities?.urls || [],
        videos: tweet.legacy?.entities?.media?.filter((media) => media.type === 'video') || [],
      }))
      .filter((tweet) => tweet.username !== twitterUsername) // do not perform action on self-tweets
      .slice(0, count);
    // TODO: Once the 'count' parameter is fixed in the 'fetchTimeline' method of the 'agent-twitter-client',
    // this workaround can be removed.
    // Related issue: https://github.com/elizaos/agent-twitter-client/issues/43
  }

  async handleTimeline() {
    console.log('Start Hanldeling Twitter Timeline');

    const tweets = await this.getTimeline(20);
    const maxActionsPerCycle = 20;
    const tweetDecisions = [];
    for (const tweet of tweets) {
      try {
        const tweetId = createUniqueUuid(this.runtime, tweet.id);
        // Skip if we've already processed this tweet
        const memory = await this.runtime.getMemoryById(tweetId);
        if (memory) {
          console.log(`Already processed tweet ID: ${tweet.id}`);
          continue;
        }

        const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

        const entityId = createUniqueUuid(this.runtime, tweet.userId);

        const message = {
          id: tweetId,
          agentId: this.runtime.agentId,
          content: {
            text: tweet.text,
            url: tweet.permanentUrl,
            imageUrls: tweet.photos?.map((photo) => photo.url) || [],
            inReplyTo: tweet.inReplyToStatusId
              ? createUniqueUuid(this.runtime, tweet.inReplyToStatusId)
              : undefined,
            source: 'twitter',
            channelType: ChannelType.GROUP,
            tweet,
          },
          entityId,
          roomId,
          createdAt: tweet.timestamp * 1000,
        };

        let state = await this.runtime.composeState(message);

        const actionRespondPrompt =
          composePromptFromState({
            state,
            template:
              this.runtime.character.templates?.twitterActionTemplate || twitterActionTemplate,
          }) +
          `

Tweet:
${tweet.text}

# Respond with qualifying action tags only.

Choose any combination of [LIKE], [RETWEET], [QUOTE], and [REPLY] that are appropriate. Each action must be on its own line. Your response must only include the chosen actions.`;

        const actionResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: actionRespondPrompt,
        });

        if (!actionResponse) {
          logger.log(`No valid actions generated for tweet ${tweet.id}`);
          continue;
        }

        const { actions } = parseActionResponseFromText(actionResponse.trim());

        tweetDecisions.push({
          tweet: tweet,
          actionResponse: actions,
          tweetState: state,
          roomId: roomId,
        });
      } catch (error) {
        logger.error(`Error processing tweet ${tweet.id}:`, error);
        continue;
      }
    }
    const rankByActionRelevance = (arr) => {
      return arr.sort((a, b) => {
        // Count the number of true values in the actionResponse object
        const countTrue = (obj: typeof a.actionResponse) =>
          Object.values(obj).filter(Boolean).length;

        const countA = countTrue(a.actionResponse);
        const countB = countTrue(b.actionResponse);

        // Primary sort by number of true values
        if (countA !== countB) {
          return countB - countA;
        }

        // Secondary sort by the "like" property
        if (a.actionResponse.like !== b.actionResponse.like) {
          return a.actionResponse.like ? -1 : 1;
        }

        // Tertiary sort keeps the remaining objects with equal weight
        return 0;
      });
    };
    // Sort the timeline based on the action decision score,
    // then slice the results according to the environment variable to limit the number of actions per cycle.
    const prioritizedTweets = rankByActionRelevance(tweetDecisions).slice(0, maxActionsPerCycle);

    this.processTimelineActions(prioritizedTweets);
  }

  private async processTimelineActions(
    tweetDecisions: {
      tweet: Tweet;
      actionResponse: ActionResponse;
      tweetState: State;
      roomId: UUID;
    }[]
  ): Promise<
    {
      tweetId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[]
  > {
    const results = [];
    for (const decision of tweetDecisions) {
      const { actionResponse, tweetState, roomId, tweet } = decision;
      const entityId = createUniqueUuid(this.runtime, tweet.userId);
      // Create standardized world and room IDs
      const worldId = createUniqueUuid(this.runtime, tweet.userId);

      // Ensure world exists first
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: `${tweet.name}'s Twitter`,
        agentId: this.runtime.agentId,
        serverId: tweet.userId,
        metadata: {
          ownership: { ownerId: tweet.userId },
          twitter: {
            username: tweet.username,
            id: tweet.userId,
            name: tweet.name,
          },
        },
      });

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: tweet.username,
        name: tweet.name,
        source: 'twitter',
        type: ChannelType.GROUP,
        channelId: tweet.conversationId,
        serverId: tweet.userId,
        worldId: worldId,
      });

      // Ensure conversation room exists
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `Conversation with ${tweet.name}`,
        source: 'twitter',
        type: ChannelType.GROUP,
        channelId: tweet.conversationId,
        serverId: tweet.userId,
        worldId: worldId,
      });
      try {
        const executedActions: string[] = [];
        // Execute actions
        if (actionResponse.like) {
          try {
            await this.twitterClient.likeTweet(tweet.id);
            executedActions.push('like');
            logger.log(`Liked tweet ${tweet.id}`);
          } catch (error) {
            logger.error(`Error liking tweet ${tweet.id}:`, error);
          }
        }

        if (actionResponse.retweet) {
          try {
            await this.twitterClient.retweet(tweet.id);
            executedActions.push('retweet');
            logger.log(`Retweeted tweet ${tweet.id}`);
          } catch (error) {
            logger.error(`Error retweeting tweet ${tweet.id}:`, error);
          }
        }
      } catch (error) {
        logger.error(`Error processing tweet ${tweet.id}:`, error);
        continue;
      }
    }

    return results;
  }
}

import type { ClientBase } from "./base";
import {
  ChannelType,
  composePromptFromState,
  createUniqueUuid,
  ModelType,
  type IAgentRuntime,
  UUID,
  State,
  Memory,
  parseKeyValueXml,
} from "@elizaos/core";
import type { Client, Tweet } from "./client/index";
import { logger } from "@elizaos/core";
import { getEpochMs } from "./utils/time";
import { getSetting } from "./utils/settings";

import {
  twitterActionTemplate,
  quoteTweetTemplate,
  replyTweetTemplate,
} from "./templates";
import { sendTweet, parseActionResponseFromText } from "./utils";
import { ActionResponse } from "./types";
import {
  ensureTwitterContext,
  createMemorySafe,
  isTweetProcessed
} from "./utils/memory";

enum TIMELINE_TYPE {
  ForYou = "foryou",
  Following = "following",
}

export class TwitterTimelineClient {
  client: ClientBase;
  twitterClient: Client;
  runtime: IAgentRuntime;
  isDryRun: boolean;
  timelineType: TIMELINE_TYPE;
  private state: any;
  private isRunning: boolean = false;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;
    this.state = state;

    const dryRunSetting =
      this.state?.TWITTER_DRY_RUN ??
      getSetting(this.runtime, "TWITTER_DRY_RUN") ??
      process.env.TWITTER_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
      dryRunSetting === "true" ||
      (typeof dryRunSetting === "string" &&
        dryRunSetting.toLowerCase() === "true");

    // Load timeline mode from runtime settings or use default
    const timelineMode =
      getSetting(this.runtime, "TWITTER_TIMELINE_MODE") ??
      process.env.TWITTER_TIMELINE_MODE;
    this.timelineType =
      timelineMode === TIMELINE_TYPE.Following
        ? TIMELINE_TYPE.Following
        : TIMELINE_TYPE.ForYou;
  }

  async start() {
    logger.info("Starting Twitter timeline client...");
    this.isRunning = true;

    const handleTwitterTimelineLoop = () => {
      if (!this.isRunning) {
        logger.info("Twitter timeline client stopped, exiting loop");
        return;
      }

      // Use unified engagement interval
      const engagementIntervalMinutes = parseInt(
        this.state?.TWITTER_ENGAGEMENT_INTERVAL ||
          (getSetting(this.runtime, "TWITTER_ENGAGEMENT_INTERVAL") as string) ||
          process.env.TWITTER_ENGAGEMENT_INTERVAL ||
          "30",
      );
      const actionInterval = engagementIntervalMinutes * 60 * 1000;

      logger.info(
        `Timeline client will check every ${engagementIntervalMinutes} minutes`,
      );

      this.handleTimeline();

      if (this.isRunning) {
        setTimeout(handleTwitterTimelineLoop, actionInterval);
      }
    };
    handleTwitterTimelineLoop();
  }

  async stop() {
    logger.info("Stopping Twitter timeline client...");
    this.isRunning = false;
  }

  async getTimeline(count: number): Promise<Tweet[]> {
    const twitterUsername = this.client.profile?.username;
    const homeTimeline =
      this.timelineType === TIMELINE_TYPE.Following
        ? await this.twitterClient.fetchFollowingTimeline(count, [])
        : await this.twitterClient.fetchHomeTimeline(count, []);

    // The timeline methods now return Tweet objects directly from v2 API
    return homeTimeline.filter((tweet) => tweet.username !== twitterUsername); // do not perform action on self-tweets
  }

  createTweetId(runtime: IAgentRuntime, tweet: Tweet) {
    return createUniqueUuid(runtime, tweet.id);
  }

  formMessage(runtime: IAgentRuntime, tweet: Tweet) {
    return {
      id: this.createTweetId(runtime, tweet),
      agentId: runtime.agentId,
      content: {
        text: tweet.text,
        url: tweet.permanentUrl,
        imageUrls: tweet.photos?.map((photo) => photo.url) || [],
        inReplyTo: tweet.inReplyToStatusId
          ? createUniqueUuid(runtime, tweet.inReplyToStatusId)
          : undefined,
        source: "twitter",
        channelType: ChannelType.GROUP,
        tweet,
      },
      entityId: createUniqueUuid(runtime, tweet.userId),
      roomId: createUniqueUuid(runtime, tweet.conversationId),
      createdAt: getEpochMs(tweet.timestamp),
    };
  }

  async handleTimeline() {
    logger.info("Starting Twitter timeline processing...");

    const tweets = await this.getTimeline(20);
    logger.info(`Fetched ${tweets.length} tweets from timeline`);

    // Use max engagements per run from environment
    const maxActionsPerCycle = parseInt(
      (getSetting(this.runtime, "TWITTER_MAX_ENGAGEMENTS_PER_RUN") as string) ||
        process.env.TWITTER_MAX_ENGAGEMENTS_PER_RUN ||
        "10",
    );

    const tweetDecisions = [];
    for (const tweet of tweets) {
      try {
        // Check if already processed using utility
        const isProcessed = await isTweetProcessed(this.runtime, tweet.id);
        if (isProcessed) {
          logger.log(`Already processed tweet ID: ${tweet.id}`);
          continue;
        }

        const roomId = createUniqueUuid(this.runtime, tweet.conversationId);

        const message = this.formMessage(this.runtime, tweet);

        let state = await this.runtime.composeState(message);

        const actionRespondPrompt =
          composePromptFromState({
            state,
            template:
              this.runtime.character.templates?.twitterActionTemplate ||
              twitterActionTemplate,
          }) +
          `
Tweet:
${tweet.text}

# Respond with qualifying action tags only.

Choose any combination of [LIKE], [RETWEET], [QUOTE], and [REPLY] that are appropriate. Each action must be on its own line. Your response must only include the chosen actions.`;

        const actionResponse = await this.runtime.useModel(
          ModelType.TEXT_SMALL,
          {
            prompt: actionRespondPrompt,
          },
        );
        const parsedResponse = parseActionResponseFromText(actionResponse);

        // Ensure a valid action response was generated
        if (!parsedResponse) {
          logger.debug(`No action response generated for tweet ${tweet.id}`);
          continue;
        }

        tweetDecisions.push({
          tweet,
          actionResponse: parsedResponse,
          tweetState: state,
          roomId,
        });

        // Limit the number of actions per cycle
        if (tweetDecisions.length >= maxActionsPerCycle) break;
      } catch (error) {
        logger.error(`Error processing tweet ${tweet.id}:`, error);
      }
    }

    // Rank by the quality of the response
    const rankByActionRelevance = (arr) => {
      return arr.sort((a, b) => {
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
    const prioritizedTweets = rankByActionRelevance(tweetDecisions);

    logger.info(`Processing ${prioritizedTweets.length} tweets with actions`);
    if (prioritizedTweets.length > 0) {
      const actionSummary = prioritizedTweets.map((td) => {
        const actions = [];
        if (td.actionResponse.like) actions.push("LIKE");
        if (td.actionResponse.retweet) actions.push("RETWEET");
        if (td.actionResponse.quote) actions.push("QUOTE");
        if (td.actionResponse.reply) actions.push("REPLY");
        return `Tweet ${td.tweet.id}: ${actions.join(", ")}`;
      });
      logger.info(`Actions to execute:\n${actionSummary.join("\n")}`);
    }

    await this.processTimelineActions(prioritizedTweets);
    logger.info("Timeline processing complete");
  }

  private async processTimelineActions(
    tweetDecisions: {
      tweet: Tweet;
      actionResponse: ActionResponse;
      tweetState: State;
      roomId: UUID;
    }[],
  ): Promise<
    {
      tweetId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[]
  > {
    const results = [];

    for (const {
      tweet,
      actionResponse,
      tweetState,
      roomId,
    } of tweetDecisions) {
      const tweetId = this.createTweetId(this.runtime, tweet);
      const executedActions = [];

      // Ensure room exists before creating memory
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: `Twitter conversation ${tweet.conversationId}`,
        source: "twitter",
        type: ChannelType.GROUP,
        channelId: tweet.conversationId,
        serverId: tweet.userId,
        worldId: createUniqueUuid(this.runtime, tweet.userId),
      });

      // Update memory with processed tweet using safe method
      const tweetMemory: Memory = {
        id: tweetId,
        entityId: createUniqueUuid(this.runtime, tweet.userId),
        content: {
          text: tweet.text,
          url: tweet.permanentUrl,
          source: "twitter",
          channelType: ChannelType.GROUP,
          tweet: tweet,
        },
        agentId: this.runtime.agentId,
        roomId,
        createdAt: getEpochMs(tweet.timestamp),
      };
      
      await createMemorySafe(this.runtime, tweetMemory, "messages");

      try {
        // ensure world and rooms, connections, and worlds are created
        const userId = tweet.userId;
        const worldId = createUniqueUuid(this.runtime, userId);
        const entityId = createUniqueUuid(this.runtime, userId);

        await this.ensureTweetWorldContext(tweet, roomId, worldId, entityId);

        if (actionResponse.like) {
          await this.handleLikeAction(tweet);
          executedActions.push("like");
        }

        if (actionResponse.retweet) {
          await this.handleRetweetAction(tweet);
          executedActions.push("retweet");
        }

        if (actionResponse.quote) {
          await this.handleQuoteAction(tweet);
          executedActions.push("quote");
        }

        if (actionResponse.reply) {
          await this.handleReplyAction(tweet);
          executedActions.push("reply");
        }

        results.push({ tweetId: tweet.id, actionResponse, executedActions });
      } catch (error) {
        logger.error(`Error processing actions for tweet ${tweet.id}:`, error);
      }
    }

    return results;
  }

  private async ensureTweetWorldContext(
    tweet: Tweet,
    roomId: UUID,
    worldId: UUID,
    entityId: UUID,
  ) {
    try {
      // Use the utility function for consistency
      await ensureTwitterContext(this.runtime, {
        userId: tweet.userId,
        username: tweet.username,
        name: tweet.name,
        conversationId: tweet.conversationId,
      });
    } catch (error) {
      logger.error(`Failed to ensure context for tweet ${tweet.id}:`, error);
      // Don't fail the entire timeline processing
    }
  }

  async handleLikeAction(tweet: Tweet) {
    try {
      if (this.isDryRun) {
        logger.log(`[DRY RUN] Would have liked tweet ${tweet.id}`);
        return;
      }
      await this.twitterClient.likeTweet(tweet.id);
      logger.log(`Liked tweet ${tweet.id}`);
    } catch (error) {
      logger.error(`Error liking tweet ${tweet.id}:`, error);
    }
  }

  async handleRetweetAction(tweet: Tweet) {
    try {
      if (this.isDryRun) {
        logger.log(`[DRY RUN] Would have retweeted tweet ${tweet.id}`);
        return;
      }
      await this.twitterClient.retweet(tweet.id);
      logger.log(`Retweeted tweet ${tweet.id}`);
    } catch (error) {
      logger.error(`Error retweeting tweet ${tweet.id}:`, error);
    }
  }

  async handleQuoteAction(tweet: Tweet) {
    try {
      const message = this.formMessage(this.runtime, tweet);

      let state = await this.runtime.composeState(message);

      const quotePrompt =
        composePromptFromState({
          state,
          template:
            this.runtime.character.templates?.quoteTweetTemplate ||
            quoteTweetTemplate,
        }) +
        `
You are responding to this tweet:
${tweet.text}`;

      const quoteResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: quotePrompt,
      });
      const responseObject = parseKeyValueXml(quoteResponse);

      if (responseObject.post) {
        if (this.isDryRun) {
          logger.log(
            `[DRY RUN] Would have quoted tweet ${tweet.id} with: ${responseObject.post}`,
          );
          return;
        }

        const result = await this.client.requestQueue.add(
          async () =>
            await this.twitterClient.sendQuoteTweet(
              responseObject.post,
              tweet.id,
            ),
        );

        const body: any = await result.json();

        const tweetResult =
          body?.data?.create_tweet?.tweet_results?.result || body?.data || body;
        if (tweetResult) {
          logger.log("Successfully posted quote tweet");
        } else {
          logger.error("Quote tweet creation failed:", body);
        }

        // Create memory for our response
        const tweetId = tweetResult?.id || Date.now().toString();
        const responseId = createUniqueUuid(this.runtime, tweetId);
        const responseMemory: Memory = {
          id: responseId,
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId: message.roomId,
          content: {
            ...responseObject,
            inReplyTo: message.id,
          },
          createdAt: Date.now(),
        };

        // Save the response to memory with error handling
        await createMemorySafe(this.runtime, responseMemory, "messages");
      }
    } catch (error) {
      logger.error("Error in quote tweet generation:", error);
    }
  }

  async handleReplyAction(tweet: Tweet) {
    try {
      const message = this.formMessage(this.runtime, tweet);

      let state = await this.runtime.composeState(message);

      const replyPrompt =
        composePromptFromState({
          state,
          template:
            this.runtime.character.templates?.replyTweetTemplate ||
            replyTweetTemplate,
        }) +
        `
You are replying to this tweet:
${tweet.text}`;

      const replyResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: replyPrompt,
      });
      const responseObject = parseKeyValueXml(replyResponse);

      if (responseObject.post) {
        if (this.isDryRun) {
          logger.log(
            `[DRY RUN] Would have replied to tweet ${tweet.id} with: ${responseObject.post}`,
          );
          return;
        }

        const result = await sendTweet(
          this.client,
          responseObject.post,
          [],
          tweet.id,
        );

        if (result) {
          logger.log("Successfully posted reply tweet");

          // Create memory for our response
          const responseId = createUniqueUuid(this.runtime, result.id);
          const responseMemory: Memory = {
            id: responseId,
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId: message.roomId,
            content: {
              ...responseObject,
              inReplyTo: message.id,
            },
            createdAt: Date.now(),
          };

          // Save the response to memory with error handling
          await createMemorySafe(this.runtime, responseMemory, "messages");
        }
      }
    } catch (error) {
      logger.error("Error in reply tweet generation:", error);
    }
  }
}

/**
 * `TwitterTimelineClient` — the home/following feed action loop. On its interval it
 * pulls the timeline, interprets each tweet's media (image/gif/video) via
 * IMAGE_DESCRIPTION, and decides per tweet whether to like/retweet/quote/reply.
 * Constructed with `ClientBase` + runtime + `TwitterClientState`, gated by
 * `TWITTER_ENABLE_ACTIONS`, driven by `TwitterClientInstance` in `services/x.service.ts`.
 */
import {
  ChannelType,
  composePromptFromState,
  createUniqueUuid,
  ElizaError,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
  type UUID,
} from "@elizaos/core";
import {
  type ClientBase,
  NO_REQUEST_RETRY,
  type TwitterAccountSession,
  type TwitterProfile,
} from "./base";
import type { Client, Tweet } from "./client/index";
import { parseTwitterInterval } from "./environment";
import {
  quoteTweetTemplate,
  replyTweetTemplate,
  twitterActionTemplate,
} from "./templates";
import type { ActionResponse, TwitterClientState } from "./types";
import { parseActionResponseFromText, sendTweet } from "./utils";
import {
  buildTwitterMessageMetadata,
  createMemorySafe,
  ensureTwitterContext,
  isTweetProcessed,
} from "./utils/memory";
import { getSetting } from "./utils/settings";
import { getEpochMs } from "./utils/time";

enum TIMELINE_TYPE {
  ForYou = "foryou",
  Following = "following",
}

type ActionableTweet = Tweet & {
  id: string;
  userId: string;
  username: string;
  name: string;
  conversationId: string;
  text: string;
  timestamp: number;
};

type TweetDecision = {
  tweet: ActionableTweet;
  actionResponse: ActionResponse;
  tweetState: State;
  roomId: UUID;
  /** Interpreted description of the tweet's media, "" when there is none. */
  mediaDescriptions: string;
};

function normalizeTweet(tweet: Tweet): ActionableTweet | null {
  if (
    typeof tweet.id !== "string" ||
    tweet.id.length === 0 ||
    typeof tweet.userId !== "string" ||
    tweet.userId.length === 0
  ) {
    return null;
  }

  const username =
    typeof tweet.username === "string" && tweet.username.length > 0
      ? tweet.username
      : "unknown";

  // Normalize the timestamp exactly once at this row boundary: absent values
  // mean "observed now", present values are unit-normalized to epoch ms, and
  // a present-but-unusable value fails the whole row closed so it can never
  // surface as a fresh tweet or an undated memory (#18965).
  const timestamp = getEpochMs(tweet.timestamp);
  if (timestamp === undefined) return null;

  return {
    ...tweet,
    id: tweet.id,
    userId: tweet.userId,
    username,
    name: tweet.name ?? username,
    conversationId: tweet.conversationId ?? tweet.id,
    text: tweet.text ?? "",
    timestamp,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionRotation(error: unknown): boolean {
  return (
    error instanceof ElizaError &&
    ["X_AUTH_NOT_INITIALIZED", "X_AUTH_SESSION_ROTATED"].includes(error.code)
  );
}

/**
 * Collect the image URLs that represent a tweet's media. Photos contribute
 * their full image; videos and animated GIFs contribute their preview frame
 * (the v2 timeline only exposes a still preview URL for non-photo media, which
 * an IMAGE_DESCRIPTION model can still interpret).
 */
function collectTweetMediaUrls(tweet: ActionableTweet): string[] {
  const urls: string[] = [];
  for (const photo of tweet.photos ?? []) {
    if (typeof photo.url === "string" && photo.url.length > 0) {
      urls.push(photo.url);
    }
  }
  for (const video of tweet.videos ?? []) {
    const url = video.preview ?? video.url;
    if (typeof url === "string" && url.length > 0) {
      urls.push(url);
    }
  }
  return urls;
}

export class TwitterTimelineClient {
  client: ClientBase;
  twitterClient: Client;
  runtime: IAgentRuntime;
  isDryRun: boolean;
  timelineType: TIMELINE_TYPE;
  private state: TwitterClientState;
  private isRunning: boolean = false;

  constructor(
    client: ClientBase,
    runtime: IAgentRuntime,
    state: TwitterClientState,
  ) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;
    this.state = state;

    // Some runtime settings pass boolean dryRun values; widen to `unknown` so
    // the boolean check below remains valid.
    const dryRunSetting: unknown =
      this.state?.TWITTER_DRY_RUN ??
      getSetting(this.runtime, "TWITTER_DRY_RUN") ??
      process.env.TWITTER_DRY_RUN;
    this.isDryRun =
      dryRunSetting === true ||
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

      // Use shared engagement interval
      const engagementIntervalMinutes = parseTwitterInterval(
        this.state?.TWITTER_ENGAGEMENT_INTERVAL ||
          (getSetting(this.runtime, "TWITTER_ENGAGEMENT_INTERVAL") as string) ||
          process.env.TWITTER_ENGAGEMENT_INTERVAL ||
          "30",
        30,
      );
      const actionInterval = engagementIntervalMinutes * 60 * 1000;

      logger.info(
        `Timeline client will check every ${engagementIntervalMinutes} minutes`,
      );

      // error-policy:J5 the scheduled promise is observed here; failures are
      // reported through the runtime because no caller awaits this loop.
      void this.handleTimeline().catch((error: unknown) => {
        this.runtime.reportError("XTimelineClient.handleTimeline", error);
      });

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

  async getTimeline(count: number): Promise<ActionableTweet[]> {
    return this.client.withAuthenticatedSession(({ profile }) =>
      this.getTimelineForProfile(count, profile),
    );
  }

  private async getTimelineForProfile(
    count: number,
    profile: TwitterProfile,
  ): Promise<ActionableTweet[]> {
    const homeTimeline =
      this.timelineType === TIMELINE_TYPE.Following
        ? await this.twitterClient.fetchFollowingTimeline(count, [])
        : await this.twitterClient.fetchHomeTimeline(count, []);

    return homeTimeline
      .map((tweet) => normalizeTweet(tweet))
      .filter((tweet): tweet is ActionableTweet => tweet !== null)
      .filter((tweet) => tweet.userId !== profile.id);
  }

  /**
   * Interpret any media attached to a tweet (images, GIFs, videos) by running
   * each through the IMAGE_DESCRIPTION model. Returns a formatted block of
   * descriptions to inject into the action/reply/quote prompts so the agent
   * reasons about what the media actually shows, not just the tweet text.
   * Returns "" when the tweet has no media or no IMAGE_DESCRIPTION model is
   * registered.
   */
  async describeTweetMedia(tweet: ActionableTweet): Promise<string> {
    const mediaUrls = collectTweetMediaUrls(tweet);
    if (mediaUrls.length === 0) {
      return "";
    }

    if (
      typeof this.runtime.getModel(ModelType.IMAGE_DESCRIPTION) !== "function"
    ) {
      logger.debug(
        `No IMAGE_DESCRIPTION model registered; skipping media interpretation for tweet ${tweet.id}`,
      );
      return "";
    }

    const descriptions: string[] = [];
    for (const imageUrl of mediaUrls) {
      try {
        const result = await this.runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          { imageUrl },
        );
        const description =
          typeof result === "string"
            ? result
            : [result?.title, result?.description].filter(Boolean).join(": ");
        if (description.length > 0) {
          descriptions.push(`- ${description}`);
        }
      } catch (error) {
        logger.warn(
          `Failed to interpret media ${imageUrl} on tweet ${tweet.id}: ${errorMessage(error)}`,
        );
      }
    }

    if (descriptions.length === 0) {
      return "";
    }

    return `\n\n# Media in the tweet\n${descriptions.join("\n")}`;
  }

  createTweetId(runtime: IAgentRuntime, tweet: ActionableTweet) {
    return createUniqueUuid(runtime, tweet.id);
  }

  formMessage(runtime: IAgentRuntime, tweet: ActionableTweet): Memory {
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
        tweet: JSON.parse(JSON.stringify(tweet)),
      },
      entityId: createUniqueUuid(runtime, tweet.userId),
      roomId: createUniqueUuid(runtime, tweet.conversationId),
      metadata: buildTwitterMessageMetadata(
        tweet,
        createUniqueUuid(runtime, tweet.userId),
        tweet.timestamp,
        this.client.accountId,
      ),
      createdAt: tweet.timestamp,
    };
  }

  async handleTimeline() {
    return this.client.withAuthenticatedSession((session) =>
      this.handleTimelineForProfile(session.profile, session),
    );
  }

  private async handleTimelineForProfile(
    profile: TwitterProfile,
    session: TwitterAccountSession,
  ) {
    logger.info("Starting Twitter timeline processing...");

    const tweets = await this.getTimelineForProfile(20, profile);
    logger.info(`Fetched ${tweets.length} tweets from timeline`);

    // Use max engagements per run from environment
    const maxActionsPerCycle = parseInt(
      (getSetting(this.runtime, "TWITTER_MAX_ENGAGEMENTS_PER_RUN") as string) ||
        process.env.TWITTER_MAX_ENGAGEMENTS_PER_RUN ||
        "10",
      10,
    );

    const tweetDecisions: TweetDecision[] = [];
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

        const state = await this.runtime.composeState(message);

        // Interpret any media (image, gif, video) so the action decision and
        // any generated reply/quote reason about the media, not just the text.
        const mediaDescriptions = await this.describeTweetMedia(tweet);

        const actionRespondPrompt =
          composePromptFromState({
            state,
            template:
              this.runtime.character.templates?.twitterActionTemplate ||
              twitterActionTemplate,
          }) +
          `
Tweet:
${tweet.text}${mediaDescriptions}

# Respond with qualifying action tags only.

Choose any combination of [LIKE], [RETWEET], [QUOTE], and [REPLY] that are appropriate. Each action must be on its own line. Your response must only include the chosen actions.`;

        const actionResponse = await this.runtime.useModel(
          ModelType.TEXT_SMALL,
          {
            prompt: actionRespondPrompt,
          },
        );
        const parsedResponse =
          parseActionResponseFromText(actionResponse).actions;

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
          mediaDescriptions,
        });

        // Limit the number of actions per cycle
        if (tweetDecisions.length >= maxActionsPerCycle) break;
      } catch (error) {
        logger.error(
          `Error processing tweet ${tweet.id}:`,
          errorMessage(error),
        );
      }
    }

    // Rank by the quality of the response
    const rankByActionRelevance = (arr: TweetDecision[]): TweetDecision[] => {
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
      const actionSummary = prioritizedTweets.map((td: TweetDecision) => {
        const actions: string[] = [];
        if (td.actionResponse.like) actions.push("LIKE");
        if (td.actionResponse.retweet) actions.push("RETWEET");
        if (td.actionResponse.quote) actions.push("QUOTE");
        if (td.actionResponse.reply) actions.push("REPLY");
        return `Tweet ${td.tweet.id}: ${actions.join(", ")}`;
      });
      logger.info(`Actions to execute:\n${actionSummary.join("\n")}`);
    }

    await this.processTimelineActions(prioritizedTweets, session);
    logger.info("Timeline processing complete");
  }

  private async processTimelineActions(
    tweetDecisions: TweetDecision[],
    session: TwitterAccountSession,
  ): Promise<
    {
      tweetId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[]
  > {
    const results: {
      tweetId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[] = [];

    for (const {
      tweet,
      actionResponse,
      tweetState: _tweetState,
      roomId,
      mediaDescriptions,
    } of tweetDecisions) {
      const tweetId = this.createTweetId(this.runtime, tweet);
      const executedActions: string[] = [];

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
          tweet: JSON.parse(JSON.stringify(tweet)),
        },
        agentId: this.runtime.agentId,
        roomId,
        metadata: buildTwitterMessageMetadata(
          tweet,
          createUniqueUuid(this.runtime, tweet.userId),
          tweet.timestamp,
          this.client.accountId,
        ),
        createdAt: tweet.timestamp,
      };

      try {
        // ensure world and rooms, connections, and worlds are created
        const userId = tweet.userId;
        const worldId = createUniqueUuid(this.runtime, userId);
        const entityId = createUniqueUuid(this.runtime, userId);

        await this.ensureTweetWorldContext(tweet, roomId, worldId, entityId);

        if (actionResponse.like) {
          this.assertCurrentSession(session);
          if (await this.handleLikeAction(tweet, session)) {
            executedActions.push("like");
          }
        }

        if (actionResponse.retweet) {
          this.assertCurrentSession(session);
          if (await this.handleRetweetAction(tweet, session)) {
            executedActions.push("retweet");
          }
        }

        if (actionResponse.quote) {
          if (await this.handleQuoteAction(tweet, mediaDescriptions, session)) {
            executedActions.push("quote");
          }
        }

        if (actionResponse.reply) {
          if (await this.handleReplyAction(tweet, mediaDescriptions, session)) {
            executedActions.push("reply");
          }
        }

        if (executedActions.length > 0) {
          await createMemorySafe(this.runtime, tweetMemory, "messages");
        }
        results.push({ tweetId: tweet.id, actionResponse, executedActions });
      } catch (error) {
        if (isSessionRotation(error)) throw error;
        // error-policy:J2 The scheduled-loop boundary reports the failed cycle;
        // retain the tweet identity instead of fabricating a partial success.
        throw new ElizaError("X timeline action failed", {
          code: "X_TIMELINE_ACTION_FAILED",
          cause: error,
          context: { tweetId: tweet.id },
        });
      }
    }

    return results;
  }

  private assertCurrentSession(session: TwitterAccountSession): void {
    if (!this.client.isAuthenticatedSessionCurrent(session)) {
      throw new ElizaError(
        "X credentials rotated before a timeline action was executed",
        { code: "X_AUTH_SESSION_ROTATED" },
      );
    }
  }

  private async ensureTweetWorldContext(
    tweet: ActionableTweet,
    _roomId: UUID,
    _worldId: UUID,
    _entityId: UUID,
  ) {
    await ensureTwitterContext(this.runtime, {
      accountId: this.client.accountId,
      userId: tweet.userId,
      username: tweet.username,
      name: tweet.name,
      conversationId: tweet.conversationId,
    });
  }

  async handleLikeAction(
    tweet: ActionableTweet,
    session?: TwitterAccountSession,
  ): Promise<boolean> {
    if (this.isDryRun) {
      logger.log(`[DRY RUN] Would have liked tweet ${tweet.id}`);
      return true;
    }
    if (session) {
      this.assertCurrentSession(session);
    }
    await this.twitterClient.likeTweet(tweet.id);
    logger.log(`Liked tweet ${tweet.id}`);
    return true;
  }

  async handleRetweetAction(
    tweet: ActionableTweet,
    session?: TwitterAccountSession,
  ): Promise<boolean> {
    if (this.isDryRun) {
      logger.log(`[DRY RUN] Would have retweeted tweet ${tweet.id}`);
      return true;
    }
    if (session) {
      this.assertCurrentSession(session);
    }
    await this.twitterClient.retweet(tweet.id);
    logger.log(`Retweeted tweet ${tweet.id}`);
    return true;
  }

  async handleQuoteAction(
    tweet: ActionableTweet,
    mediaDescriptions: string = "",
    session?: TwitterAccountSession,
  ): Promise<boolean> {
    try {
      const message = this.formMessage(this.runtime, tweet);

      const state = await this.runtime.composeState(message);

      const quotePrompt =
        composePromptFromState({
          state,
          template:
            this.runtime.character.templates?.quoteTweetTemplate ||
            quoteTweetTemplate,
        }) +
        `
You are responding to this tweet:
${tweet.text}${mediaDescriptions}`;

      const quoteResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: quotePrompt,
      });
      const responseObject =
        (parseJSONObjectFromText(quoteResponse) as Record<
          string,
          unknown
        > | null) ?? {};

      if (responseObject.post) {
        if (this.isDryRun) {
          logger.log(
            `[DRY RUN] Would have quoted tweet ${tweet.id} with: ${responseObject.post}`,
          );
          return true;
        }

        const sendQuote = () =>
          this.client.requestQueue.add(async () => {
            if (session) this.assertCurrentSession(session);
            return await this.twitterClient.sendQuoteTweet(
              String(responseObject.post),
              tweet.id,
            );
          }, NO_REQUEST_RETRY);
        const result = await sendQuote();

        try {
          const resultWithJson = result as { json: () => Promise<unknown> };
          const body = (await resultWithJson.json()) as {
            id?: string;
            data?: {
              id?: string;
              create_tweet?: {
                tweet_results?: { result?: { id?: string } };
              };
            };
          } | null;
          const tweetResult =
            body?.data?.create_tweet?.tweet_results?.result ||
            body?.data ||
            body;
          const tweetId = tweetResult?.id;
          if (!tweetId) {
            throw new ElizaError("X returned no usable quote-tweet receipt", {
              code: "X_POST_RESPONSE_INVALID",
            });
          }
          logger.log("Successfully posted quote tweet");
          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, tweetId),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId: message.roomId,
            content: {
              ...responseObject,
              source: "twitter",
              inReplyTo: message.id,
            },
            metadata: {
              type: "message",
              source: "twitter",
              accountId: this.client.accountId,
              provider: "twitter",
              fromBot: true,
              messageIdFull: tweetId,
              twitter: {
                accountId: this.client.accountId,
                tweetId,
                inReplyTo: tweet.id,
              },
            } satisfies Memory["metadata"],
            createdAt: Date.now(),
          };
          await createMemorySafe(this.runtime, responseMemory, "messages");
        } catch (error) {
          // error-policy:J7 X already accepted the quote, so replaying the
          // action would duplicate an external effect. Report receipt loss and
          // settle the source tweet as processed.
          this.runtime.reportError("XTimeline.quoteReceipt", error, {
            accountId: this.client.accountId,
            tweetId: tweet.id,
          });
        }
        return true;
      }
      return false;
    } catch (error) {
      if (isSessionRotation(error)) throw error;
      // error-policy:J2 The scheduled-loop boundary reports model and provider
      // failures; returning false would mislabel a broken action as IGNORE.
      throw new ElizaError("X quote-tweet action failed", {
        code: "X_TIMELINE_ACTION_FAILED",
        cause: error,
        context: { tweetId: tweet.id },
      });
    }
  }

  async handleReplyAction(
    tweet: ActionableTweet,
    mediaDescriptions: string = "",
    session?: TwitterAccountSession,
  ): Promise<boolean> {
    try {
      const message = this.formMessage(this.runtime, tweet);

      const state = await this.runtime.composeState(message);

      const replyPrompt =
        composePromptFromState({
          state,
          template:
            this.runtime.character.templates?.replyTweetTemplate ||
            replyTweetTemplate,
        }) +
        `
You are replying to this tweet:
${tweet.text}${mediaDescriptions}`;

      const replyResponse = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: replyPrompt,
      });
      const responseObject =
        (parseJSONObjectFromText(replyResponse) as Record<
          string,
          unknown
        > | null) ?? {};

      if (responseObject.post) {
        if (this.isDryRun) {
          logger.log(
            `[DRY RUN] Would have replied to tweet ${tweet.id} with: ${responseObject.post}`,
          );
          return true;
        }

        const sendReply = () =>
          sendTweet(this.client, String(responseObject.post), [], tweet.id);
        if (session) this.assertCurrentSession(session);
        const result = await sendReply();

        if (result) {
          logger.log("Successfully posted reply tweet");

          try {
            const responseMemory: Memory = {
              id: createUniqueUuid(this.runtime, result.id),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              roomId: message.roomId,
              content: {
                ...responseObject,
                source: "twitter",
                inReplyTo: message.id,
              },
              metadata: {
                type: "message",
                source: "twitter",
                accountId: this.client.accountId,
                provider: "twitter",
                fromBot: true,
                messageIdFull: result.id,
                twitter: {
                  accountId: this.client.accountId,
                  tweetId: result.id,
                  inReplyTo: tweet.id,
                },
              } satisfies Memory["metadata"],
              createdAt: Date.now(),
            };
            await createMemorySafe(this.runtime, responseMemory, "messages");
          } catch (error) {
            // error-policy:J7 X already accepted the reply; surface local
            // receipt loss without turning a successful egress into a retry.
            this.runtime.reportError("XTimeline.replyReceipt", error, {
              accountId: this.client.accountId,
              tweetId: tweet.id,
              replyId: result.id,
            });
          }
          return true;
        }
      }
      return false;
    } catch (error) {
      if (isSessionRotation(error)) throw error;
      // error-policy:J2 The scheduled-loop boundary reports model and provider
      // failures; returning false would mislabel a broken action as IGNORE.
      throw new ElizaError("X reply action failed", {
        code: "X_TIMELINE_ACTION_FAILED",
        cause: error,
        context: { tweetId: tweet.id },
      });
    }
  }
}

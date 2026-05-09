import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseBooleanFromText,
  setTrajectoryPurpose,
  type UUID,
  withStandaloneTrajectory,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { getRandomInterval } from "./environment";
import type { MediaData, TwitterClientState } from "./types";
import type { SentTweet } from "./utils";
import { sendTweet } from "./utils";
import {
  addToRecentTweets,
  createMemorySafe,
  ensureTwitterContext,
  isDuplicateTweet,
} from "./utils/memory";
import { getSetting } from "./utils/settings";

function formatStyleForPrompt(style: unknown): string {
  if (typeof style === "string") {
    return style;
  }
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    return "";
  }

  const record = style as Record<string, unknown>;
  if (Array.isArray(record.all)) {
    return record.all.filter((item) => typeof item === "string").join(", ");
  }

  return Object.entries(record)
    .map(([key, value]) => {
      const formatted = Array.isArray(value)
        ? value.map((item) => String(item)).join(", ")
        : String(value);
      return `${key}: ${formatted}`;
    })
    .join("; ");
}

function stateSetting(
  state: TwitterClientState,
  key: string,
): string | boolean | undefined {
  const value = (state as Record<string, unknown> | undefined)?.[key];
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Class representing a Twitter post client for generating and posting tweets.
 */
export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername = "";
  private isDryRun: boolean;
  private state: TwitterClientState;
  private isRunning: boolean = false;
  private isPosting: boolean = false; // Add lock to prevent concurrent posting

  /**
   * Creates an instance of TwitterPostClient.
   * @param {ClientBase} client - The client instance.
   * @param {IAgentRuntime} runtime - The runtime instance.
   * @param {TwitterClientState} state - The state object containing configuration settings
   */
  constructor(
    client: ClientBase,
    runtime: IAgentRuntime,
    state: TwitterClientState,
  ) {
    this.client = client;
    this.state = state;
    this.runtime = runtime;
    const dryRunSetting =
      this.state?.TWITTER_DRY_RUN ??
      getSetting(this.runtime, "TWITTER_DRY_RUN");
    this.isDryRun = parseBooleanFromText(dryRunSetting);

    // Log configuration on initialization
    logger.log("Twitter Post Client Configuration:");
    logger.log(`- Dry Run Mode: ${this.isDryRun ? "Enabled" : "Disabled"}`);

    const postIntervalMin = parseInt(
      this.state?.TWITTER_POST_INTERVAL_MIN ||
        (getSetting(this.runtime, "TWITTER_POST_INTERVAL_MIN") as string) ||
        "90",
      10,
    );
    const postIntervalMax = parseInt(
      this.state?.TWITTER_POST_INTERVAL_MAX ||
        (getSetting(this.runtime, "TWITTER_POST_INTERVAL_MAX") as string) ||
        "150",
      10,
    );
    logger.log(
      `- Post Interval: ${postIntervalMin}-${postIntervalMax} minutes (randomized)`,
    );
  }

  /**
   * Stops the Twitter post client
   */
  async stop() {
    logger.log("Stopping Twitter post client...");
    this.isRunning = false;
  }

  /**
   * Starts the Twitter post client, setting up a loop to periodically generate new tweets.
   */
  async start() {
    logger.log("Starting Twitter post client...");
    this.isRunning = true;

    const generateNewTweetLoop = async () => {
      if (!this.isRunning) {
        logger.log("Twitter post client stopped, exiting loop");
        return;
      }

      await this.generateNewTweet();

      if (!this.isRunning) {
        logger.log("Twitter post client stopped after tweet, exiting loop");
        return;
      }

      // Get random post interval in minutes
      const postIntervalMinutes = getRandomInterval(this.runtime, "post");

      // Convert to milliseconds
      const interval = postIntervalMinutes * 60 * 1000;

      logger.info(
        `Next tweet scheduled in ${postIntervalMinutes.toFixed(1)} minutes`,
      );

      // Wait for the interval AFTER generating the tweet
      await new Promise((resolve) => setTimeout(resolve, interval));

      if (this.isRunning) {
        // Schedule the next iteration
        generateNewTweetLoop();
      }
    };

    // Wait a bit longer to ensure profile is loaded
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check if we should generate a tweet immediately
    const postImmediately =
      stateSetting(this.state, "TWITTER_POST_IMMEDIATELY") ??
      (getSetting(this.runtime, "TWITTER_POST_IMMEDIATELY") as
        | string
        | boolean
        | undefined);

    if (parseBooleanFromText(postImmediately)) {
      logger.info(
        "TWITTER_POST_IMMEDIATELY is true, generating initial tweet now",
      );
      // Try multiple times in case profile isn't ready
      let retries = 0;
      while (retries < 5) {
        const success = await this.generateNewTweet();
        if (success) break;

        retries++;
        logger.info(`Retrying immediate tweet (attempt ${retries}/5)...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    // Start the regular generation loop
    generateNewTweetLoop();
  }

  /**
   * Handles the creation and posting of a tweet by emitting standardized events.
   * This approach aligns with our platform-independent architecture.
   * @returns {Promise<boolean>} true if tweet was posted successfully
   */
  async generateNewTweet(): Promise<boolean> {
    return await withStandaloneTrajectory(
      this.runtime,
      {
        source: "plugin-x:auto-post",
        metadata: {
          platform: "x",
          kind: "public_post_generation",
          username: this.client.profile?.username,
        },
      },
      async () => {
        setTrajectoryPurpose("background");
        return await this.generateNewTweetInner();
      },
    );
  }

  private async generateNewTweetInner(): Promise<boolean> {
    logger.info("Attempting to generate new tweet...");

    // Prevent concurrent posting
    if (this.isPosting) {
      logger.info("Already posting a tweet, skipping concurrent attempt");
      return false;
    }

    this.isPosting = true;

    try {
      // Create the timeline room ID for storing the post
      const userId = this.client.profile?.id;
      if (!userId) {
        logger.error("Cannot generate tweet: Twitter profile not available");
        this.isPosting = false; // Reset flag
        return false;
      }

      logger.info(
        `Generating tweet for user: ${this.client.profile?.username} (${userId})`,
      );

      // Create standardized world and room IDs
      const _worldId = createUniqueUuid(this.runtime, userId) as UUID;
      const roomId = createUniqueUuid(this.runtime, `${userId}-home`) as UUID;

      // Generate tweet content using the runtime's model
      const state = await this.runtime
        .composeState({
          agentId: this.runtime.agentId,
          entityId: this.runtime.agentId,
          roomId,
          content: { text: "", type: "post" },
          createdAt: Date.now(),
        } as Memory)
        .catch((error) => {
          logger.warn(
            "Error composing state, using minimal state:",
            errorMessage(error),
          );
          // Return minimal state if composition fails
          return {
            agentId: this.runtime.agentId,
            recentMemories: [],
            values: {},
          };
        });

      // Create a prompt for tweet generation
      const tweetPrompt = `You are ${this.runtime.character.name}.
${this.runtime.character.bio}

CRITICAL: Generate a tweet that sounds like YOU, not a generic motivational poster or LinkedIn influencer.

${
  this.runtime.character.messageExamples &&
  this.runtime.character.messageExamples.length > 0
    ? `
Example tweets that capture your voice:
${this.runtime.character.messageExamples
  .map((example) => {
    if (Array.isArray(example)) {
      const second = example[1] as { content?: { text?: unknown } } | undefined;
      const text = second?.content?.text;
      return typeof text === "string" ? text : "";
    }
    return example;
  })
  .filter(Boolean)
  .slice(0, 5)
  .join("\n")}
`
    : ""
}

Style guidelines:
- Be authentic, opinionated, and specific - no generic platitudes
- Use your unique voice and perspective
- Share hot takes, unpopular opinions, or specific insights
- Be conversational, not preachy
- If you use emojis, use them sparingly and purposefully
- Length: 50-280 characters (keep it punchy)
- NO hashtags unless absolutely essential
- NO generic motivational content

Your interests: ${this.runtime.character.topics?.join(", ") || "technology, crypto, AI"}

${
  this.runtime.character.style
    ? `Your style: ${formatStyleForPrompt(this.runtime.character.style)}`
    : ""
}

Recent context:
${
  (Array.isArray(state.recentMemories) ? state.recentMemories : [])
    .slice(0, 3)
    .map((m: Memory) => m.content.text)
    .join("\n") || "No recent context"
}

Generate a single tweet that sounds like YOU would actually write it:`;

      // Use the runtime's model to generate tweet content
      const generatedContent = await this.runtime.useModel(
        ModelType.TEXT_SMALL,
        {
          prompt: tweetPrompt,
          temperature: 0.9, // Increased for more creativity
          maxTokens: 100,
        },
      );

      const tweetText = generatedContent.trim();

      if (!tweetText || tweetText.length === 0) {
        logger.error("Generated empty tweet content");
        return false;
      }

      if (tweetText.includes("Error: Missing")) {
        logger.error("Error in generated content:", tweetText);
        return false;
      }

      // Validate tweet length
      if (tweetText.length > 280) {
        logger.warn(
          `Generated tweet too long (${tweetText.length} chars), truncating...`,
        );
        // Truncate to the last complete sentence within 280 chars
        const sentences = tweetText.match(/[^.!?]+[.!?]+/g) || [tweetText];
        let truncated = "";
        for (const sentence of sentences) {
          if ((truncated + sentence).length <= 280) {
            truncated += sentence;
          } else {
            break;
          }
        }
        const finalTweet =
          truncated.trim() || `${tweetText.substring(0, 277)}...`;
        logger.info(`Truncated tweet: ${finalTweet}`);

        // Post the truncated tweet
        if (this.isDryRun) {
          logger.info(`[DRY RUN] Would post tweet: ${finalTweet}`);
          return false;
        }

        const result = await this.postToTwitter(finalTweet, []);

        if (result === null) {
          logger.info("Skipped posting duplicate tweet");
          return false;
        }

        const tweetId = result.id;
        logger.info(`Tweet posted successfully! ID: ${tweetId}`);

        // Don't save to memory if room creation might fail
        logger.info(
          "Tweet posted successfully (memory saving disabled due to room constraints)",
        );
        return true;
      }

      logger.info(`Generated tweet: ${tweetText}`);

      // Post the tweet
      if (this.isDryRun) {
        logger.info(`[DRY RUN] Would post tweet: ${tweetText}`);
        return false;
      }

      const result = await this.postToTwitter(tweetText, []);

      // If result is null, it means we detected a duplicate tweet and skipped posting
      if (result === null) {
        logger.info("Skipped posting duplicate tweet");
        return false;
      }

      const tweetId = result.id;
      logger.info(`Tweet posted successfully! ID: ${tweetId}`);

      if (result) {
        const postedTweetId = createUniqueUuid(this.runtime, tweetId);

        try {
          // Ensure context exists with error handling
          const context = await ensureTwitterContext(this.runtime, {
            accountId: this.client.accountId,
            userId,
            username: this.client.profile?.username || "unknown",
            conversationId: `${userId}-home`,
          });

          // Create memory for the posted tweet with retry logic
          const postedMemory: Memory = {
            id: postedTweetId,
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId: context.roomId,
            content: {
              text: tweetText,
              source: "twitter",
              channelType: ChannelType.FEED,
              type: "post",
              metadata: {
                accountId: this.client.accountId,
                tweetId,
                postedAt: Date.now(),
              },
            },
            metadata: {
              type: "message",
              source: "twitter",
              accountId: this.client.accountId,
              provider: "twitter",
              messageIdFull: tweetId,
              chatType: ChannelType.FEED,
              fromBot: true,
            } as unknown as Memory["metadata"],
            createdAt: Date.now(),
          };

          await createMemorySafe(this.runtime, postedMemory, "messages");
          logger.info("Tweet posted and saved to memory successfully");
        } catch (error) {
          logger.error("Failed to save tweet memory:", errorMessage(error));
          // Don't fail the tweet posting if memory creation fails
        }

        return true;
      }
      return false;
    } catch (error) {
      logger.error("Error generating tweet:", errorMessage(error));
      return false;
    } finally {
      this.isPosting = false;
    }
  }

  /**
   * Posts content to Twitter
   * @param {string} text The tweet text to post
   * @param {MediaData[]} mediaData Optional media to attach to the tweet
   * @returns {Promise<any>} The result from the Twitter API
   */
  private async postToTwitter(
    text: string,
    mediaData: MediaData[] = [],
  ): Promise<SentTweet | null> {
    try {
      // Check if this tweet is a duplicate of recent tweets
      const username = this.client.profile?.username;
      if (!username) {
        logger.error("No profile username available");
        return null;
      }

      // Check for duplicates in recent tweets
      const isDuplicate = await isDuplicateTweet(this.runtime, username, text);
      if (isDuplicate) {
        logger.warn(
          "Tweet is a duplicate of a recent post. Skipping to avoid duplicate.",
        );
        return null;
      }

      // Handle media uploads if needed
      const mediaIds: string[] = [];

      if (mediaData && mediaData.length > 0) {
        logger.log(`Uploading ${mediaData.length} media file(s)...`);

        for (const media of mediaData) {
          try {
            // Upload media using Twitter API v1 (v2 doesn't support media upload yet)
            const mediaId = await this.client.twitterClient.uploadMedia(
              media.data,
              {
                mimeType: media.mediaType,
              },
            );

            mediaIds.push(mediaId);
            logger.log(`Media uploaded successfully. Media ID: ${mediaId}`);
          } catch (error) {
            logger.error("Error uploading media:", errorMessage(error));
            // Continue with other media files even if one fails
          }
        }

        logger.log(
          `Successfully uploaded ${mediaIds.length}/${mediaData.length} media file(s)`,
        );
      }

      const result = await sendTweet(
        this.client,
        text,
        mediaData,
        undefined,
        mediaIds,
      );

      // Add to recent tweets cache to prevent future duplicates
      await addToRecentTweets(this.runtime, username, text);

      return result;
    } catch (error) {
      logger.error("Error posting to Twitter:", errorMessage(error));
      throw error;
    }
  }
}

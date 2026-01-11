import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseBooleanFromText,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { getRandomInterval } from "./environment";
import type { MediaData, TweetResponse } from "./types";
import { sendTweet } from "./utils";
import {
  addToRecentTweets,
  createMemorySafe,
  ensureTwitterContext,
  isDuplicateTweet,
} from "./utils/memory";
import { getSetting } from "./utils/settings";
/**
 * Class representing an X post client for generating and posting.
 */
export class XPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  xUsername: string;
  private isDryRun: boolean;
  private state: Record<string, unknown>;
  private isRunning: boolean = false;
  private isPosting: boolean = false; // Add lock to prevent concurrent posting

  /**
   * Creates an instance of XPostClient.
   * @param {ClientBase} client - The client instance.
   * @param {IAgentRuntime} runtime - The runtime instance.
   * @param {Record<string, unknown>} state - The state object containing configuration settings
   */
  constructor(client: ClientBase, runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.client = client;
    this.state = state;
    this.runtime = runtime;
    const dryRunSetting =
      typeof this.state?.TWITTER_DRY_RUN === "string" ||
      typeof this.state?.TWITTER_DRY_RUN === "boolean" ||
      this.state?.TWITTER_DRY_RUN === true ||
      this.state?.TWITTER_DRY_RUN === false
        ? this.state.TWITTER_DRY_RUN
        : getSetting(this.runtime, "TWITTER_DRY_RUN");
    this.isDryRun = parseBooleanFromText(dryRunSetting);

    // Get X username from settings
    const usernameSetting =
      getSetting(this.runtime, "TWITTER_USERNAME") || this.state?.TWITTER_USERNAME;
    this.xUsername = typeof usernameSetting === "string" ? usernameSetting : "";

    // Log configuration on initialization
    logger.log("X Post Client Configuration:");
    logger.log(`- Dry Run Mode: ${this.isDryRun ? "Enabled" : "Disabled"}`);

    const postIntervalMin = parseInt(
      (typeof this.state?.TWITTER_POST_INTERVAL_MIN === "string"
        ? this.state.TWITTER_POST_INTERVAL_MIN
        : null) ||
        (getSetting(this.runtime, "TWITTER_POST_INTERVAL_MIN") as string) ||
        "90",
      10
    );
    const postIntervalMax = parseInt(
      (typeof this.state?.TWITTER_POST_INTERVAL_MAX === "string"
        ? this.state.TWITTER_POST_INTERVAL_MAX
        : null) ||
        (getSetting(this.runtime, "TWITTER_POST_INTERVAL_MAX") as string) ||
        "150",
      10
    );
    logger.log(`- Post Interval: ${postIntervalMin}-${postIntervalMax} minutes (randomized)`);
  }

  /**
   * Stops the X post client
   */
  async stop() {
    logger.log("Stopping X post client...");
    this.isRunning = false;
  }

  /**
   * Starts the X post client, setting up a loop to periodically generate new posts.
   */
  async start() {
    logger.log("Starting X post client...");
    this.isRunning = true;

    const generateNewTweetLoop = async () => {
      if (!this.isRunning) {
        logger.log("X post client stopped, exiting loop");
        return;
      }

      await this.generateNewTweet();

      if (!this.isRunning) {
        logger.log("X post client stopped after post, exiting loop");
        return;
      }

      // Get random post interval in minutes
      const postIntervalMinutes = getRandomInterval(this.runtime, "post");

      // Convert to milliseconds
      const interval = postIntervalMinutes * 60 * 1000;

      logger.info(`Next post scheduled in ${postIntervalMinutes.toFixed(1)} minutes`);

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
      typeof this.state?.TWITTER_POST_IMMEDIATELY === "string" ||
      typeof this.state?.TWITTER_POST_IMMEDIATELY === "boolean"
        ? this.state.TWITTER_POST_IMMEDIATELY
        : (getSetting(this.runtime, "TWITTER_POST_IMMEDIATELY") as string);

    if (parseBooleanFromText(postImmediately)) {
      logger.info("TWITTER_POST_IMMEDIATELY is true, generating initial post now");
      // Try multiple times in case profile isn't ready
      let retries = 0;
      while (retries < 5) {
        const success = await this.generateNewTweet();
        if (success) break;

        retries++;
        logger.info(`Retrying immediate post (attempt ${retries}/5)...`);
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
    logger.info("Attempting to generate new post...");

    // Prevent concurrent posting
    if (this.isPosting) {
      logger.info("Already posting, skipping concurrent attempt");
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

      logger.info(`Generating post for user: ${this.client.profile?.username} (${userId})`);

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
          logger.warn("Error composing state, using minimal state:", error);
          // Return minimal state if composition fails
          return {
            agentId: this.runtime.agentId,
            recentMemories: [],
            values: {},
          };
        });

      // Create a prompt for post generation
      const tweetPrompt = `You are ${this.runtime.character.name}.
${this.runtime.character.bio}

CRITICAL: Generate a post that sounds like YOU, not a generic motivational poster or LinkedIn influencer.

${
  this.runtime.character.messageExamples && this.runtime.character.messageExamples.length > 0
    ? `
Example posts that capture your voice:
${this.runtime.character.messageExamples
  .map((example: unknown) =>
    Array.isArray(example)
      ? (example[1] as { content?: { text?: string } })?.content?.text || ""
      : String(example)
  )
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
    ? `Your style: ${
        typeof this.runtime.character.style === "object"
          ? this.runtime.character.style.all?.join(", ") ||
            JSON.stringify(this.runtime.character.style)
          : this.runtime.character.style
      }`
    : ""
}

Recent context:
${
  Array.isArray(state.recentMemories) && state.recentMemories.length > 0
    ? state.recentMemories
        .slice(0, 3)
        .map((m: Memory) => m.content?.text || "")
        .join("\n") || "No recent context"
    : "No recent context"
}

Generate a single post that sounds like YOU would actually write it:`;

      // Use the runtime's model to generate tweet content
      const generatedContent = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: tweetPrompt,
        temperature: 0.9, // Increased for more creativity
        maxTokens: 100,
      });

      const tweetText = generatedContent.trim();

      if (!tweetText || tweetText.length === 0) {
        logger.error("Generated empty post content");
        return false;
      }

      if (tweetText.includes("Error: Missing")) {
        logger.error("Error in generated content:", tweetText);
        return false;
      }

      // Validate post length
      if (tweetText.length > 280) {
        logger.warn(`Generated post too long (${tweetText.length} chars), truncating...`);
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
        const finalTweet = truncated.trim() || `${tweetText.substring(0, 277)}...`;
        logger.info(`Truncated post: ${finalTweet}`);

        // Post the truncated post
        if (this.isDryRun) {
          logger.info(`[DRY RUN] Would post: ${finalTweet}`);
          return false;
        }

        const result = await this.postToX(finalTweet, []);

        if (result === null) {
          logger.info("Skipped posting duplicate post");
          return false;
        }

        const tweetId = result.id ?? result.data?.id ?? result.data?.data?.id;
        logger.info(`Post created successfully! ID: ${tweetId}`);

        // Don't save to memory if room creation might fail
        logger.info("Post created successfully (memory saving disabled due to room constraints)");
        return true;
      }

      logger.info(`Generated post: ${tweetText}`);

      // Post the post
      if (this.isDryRun) {
        logger.info(`[DRY RUN] Would post: ${tweetText}`);
        return false;
      }

      const result = await this.postToX(tweetText, []);

      // If result is null, it means we detected a duplicate post and skipped posting
      if (result === null) {
        logger.info("Skipped posting duplicate post");
        return false;
      }

      const tweetId = result.id ?? result.data?.id ?? result.data?.data?.id;
      logger.info(`Post created successfully! ID: ${tweetId}`);

      if (result && tweetId) {
        const postedTweetId = createUniqueUuid(this.runtime, tweetId);

        try {
          // Ensure context exists with error handling
          const context = await ensureTwitterContext(this.runtime, {
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
                tweetId,
                postedAt: Date.now(),
              },
            },
            createdAt: Date.now(),
          };

          await createMemorySafe(this.runtime, postedMemory, "messages");
          logger.info("Tweet posted and saved to memory successfully");
        } catch (error) {
          logger.error(
            "Failed to save tweet memory:",
            error instanceof Error ? error.message : String(error)
          );
          // Don't fail the tweet posting if memory creation fails
        }

        return true;
      } else {
        logger.warn("Tweet generation returned no result");
        return false;
      }
    } catch (error) {
      logger.error(
        "Error generating tweet:",
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      this.isPosting = false;
    }
  }

  /**
   * Posts content to Twitter
   * @param {string} text The tweet text to post
   * @param {MediaData[]} mediaData Optional media to attach to the tweet
   * @returns {Promise<TweetResponse | null>} The result from the Twitter API
   */
  private async postToTwitter(
    text: string,
    mediaData: MediaData[] = []
  ): Promise<TweetResponse | null> {
    // Check if this tweet is a duplicate of recent tweets
    const username = this.client.profile?.username;
    if (!username) {
      logger.error("No profile username available");
      return null;
    }

    // Check for duplicates in recent tweets
    const isDuplicate = await isDuplicateTweet(this.runtime, username, text);
    if (isDuplicate) {
      logger.warn("Tweet is a duplicate of a recent post. Skipping to avoid duplicate.");
      return null;
    }

    // Handle media uploads if needed
    const _mediaIds: string[] = [];

    if (mediaData && mediaData.length > 0) {
      logger.warn("Media upload not currently supported with the modern Twitter API");
    }

    const result = await sendTweet(this.client, text, mediaData);

    // Add to recent tweets cache to prevent future duplicates
    await addToRecentTweets(this.runtime, username, text);

    return result;
  }
}

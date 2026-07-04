/**
 * `TwitterPostClient` — the autonomous tweet-generation loop. On its randomized
 * interval (or immediately when `TWITTER_POST_IMMEDIATELY`) it composes a tweet from
 * character state via the post templates and publishes it through `sendTweet`,
 * honoring `TWITTER_DRY_RUN`. Constructed with `ClientBase` + runtime +
 * `TwitterClientState`, gated by `TWITTER_ENABLE_POST`, driven by `TwitterClientInstance`.
 */
import {
  createUniqueUuid,
  type EventPayload,
  EventType,
  type IAgentRuntime,
  logger,
  parseBooleanFromText,
  setTrajectoryPurpose,
  type UUID,
  withStandaloneTrajectory,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import { getRandomInterval } from "./environment";
import type { TwitterClientState } from "./types";
import { getSetting } from "./utils/settings";
import { createTwitterPostCallback } from "./utils/twitter-post-callback";

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
      const worldId = createUniqueUuid(this.runtime, userId) as UUID;
      const roomId = createUniqueUuid(this.runtime, `${userId}-home`) as UUID;
      const username = this.client.profile?.username || "unknown";
      let posted = false;

      const callback = createTwitterPostCallback({
        client: this.client,
        runtime: this.runtime,
        state: this.state,
        roomId,
        userId,
        username,
        onPosted: () => {
          posted = true;
        },
      });

      await this.runtime.emitEvent(EventType.POST_GENERATED, {
        runtime: this.runtime,
        callback,
        worldId,
        userId: this.runtime.agentId,
        roomId,
        source: "twitter",
        accountId: this.client.accountId,
      } as EventPayload);

      return posted;
    } catch (error) {
      logger.error("Error generating tweet:", errorMessage(error));
      return false;
    } finally {
      this.isPosting = false;
    }
  }
}

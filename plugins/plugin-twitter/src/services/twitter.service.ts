import { Service, type IAgentRuntime, logger, parseBooleanFromText } from "@elizaos/core";
import { TwitterInteractionClient } from "../interactions";
import { TwitterPostClient } from "../post";
import { TwitterTimelineClient } from "../timeline";
import { TwitterDiscoveryClient } from "../discovery";
import { validateTwitterConfig } from "../environment";
import { ClientBase } from "../base";
import type { ITwitterClient } from "../types";
import { getSetting } from "../utils/settings";

/**
 * A manager that orchestrates all specialized Twitter logic:
 * - client: base operations (login, timeline caching, etc.)
 * - post: autonomous posting logic
 * - interaction: handling mentions, replies, and autonomous targeting
 * - timeline: processing timeline for actions (likes, retweets, replies)
 * - discovery: autonomous content discovery and engagement
 */
export class TwitterClientInstance implements ITwitterClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
  timeline?: TwitterTimelineClient;
  discovery?: TwitterDiscoveryClient;

  constructor(runtime: IAgentRuntime, state: any) {
    // Pass twitterConfig to the base client
    this.client = new ClientBase(runtime, state);

    // Posting logic
    const postEnabled = parseBooleanFromText(getSetting(runtime, "TWITTER_ENABLE_POST"))
    logger.debug(
      `TWITTER_ENABLE_POST setting value: ${JSON.stringify(postEnabled)}, type: ${typeof postEnabled}`,
    );

    if (postEnabled) {
      logger.info("Twitter posting is ENABLED - creating post client");
      this.post = new TwitterPostClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter posting is DISABLED - set TWITTER_ENABLE_POST=true to enable automatic posting",
      );
    }

    // Mentions and interactions
    const repliesEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_REPLIES") ??
        process.env.TWITTER_ENABLE_REPLIES) !== "false";

    if (repliesEnabled) {
      logger.info("Twitter replies/interactions are ENABLED");
      this.interaction = new TwitterInteractionClient(
        this.client,
        runtime,
        state,
      );
    } else {
      logger.info("Twitter replies/interactions are DISABLED");
    }

    // Timeline actions (likes, retweets, replies)
    const actionsEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_ACTIONS") ??
        process.env.TWITTER_ENABLE_ACTIONS) === "true";

    if (actionsEnabled) {
      logger.info("Twitter timeline actions are ENABLED");
      this.timeline = new TwitterTimelineClient(this.client, runtime, state);
    } else {
      logger.info("Twitter timeline actions are DISABLED");
    }

    // Discovery service for autonomous content discovery
    const discoveryEnabled =
      (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
        process.env.TWITTER_ENABLE_DISCOVERY) === "true" ||
      (actionsEnabled &&
        (getSetting(runtime, "TWITTER_ENABLE_DISCOVERY") ??
          process.env.TWITTER_ENABLE_DISCOVERY) !== "false");

    if (discoveryEnabled) {
      logger.info("Twitter discovery service is ENABLED");
      this.discovery = new TwitterDiscoveryClient(this.client, runtime, state);
    } else {
      logger.info(
        "Twitter discovery service is DISABLED - set TWITTER_ENABLE_DISCOVERY=true to enable",
      );
    }
  }
}

export class TwitterService extends Service {
  static serviceType = "twitter";

  // Add the required abstract property
  capabilityDescription =
    "The agent is able to send and receive messages on Twitter";

  public twitterClient?: TwitterClientInstance;

  constructor() {
    super();
  }

  static async start(runtime: IAgentRuntime): Promise<TwitterService> {
    const service = new TwitterService();
    service.runtime = runtime;

    try {
      await validateTwitterConfig(runtime);
      logger.log("✅ Twitter configuration validated successfully");

      // Create the Twitter client instance
      service.twitterClient = new TwitterClientInstance(runtime, {});

      // Initialize the base client (this is where the runtime database access happens)
      await service.twitterClient.client.init();

      // Start appropriate services based on configuration
      if (service.twitterClient.post) {
        logger.log("📮 Starting Twitter post client...");
        await service.twitterClient.post.start();
      }

      if (service.twitterClient.interaction) {
        logger.log("💬 Starting Twitter interaction client...");
        await service.twitterClient.interaction.start();
      }

      if (service.twitterClient.timeline) {
        logger.log("📊 Starting Twitter timeline client...");
        await service.twitterClient.timeline.start();
      }

      if (service.twitterClient.discovery) {
        logger.log("🔍 Starting Twitter discovery client...");
        await service.twitterClient.discovery.start();
      }

      logger.log("✅ Twitter service started successfully");
    } catch (error) {
      logger.error("🚨 Failed to start Twitter service:", error);
      throw error;
    }

    return service;
  }

  async stop(): Promise<void> {
    // Stop all the clients
    if (this.twitterClient?.post) {
      await this.twitterClient.post.stop();
    }

    if (this.twitterClient?.interaction) {
      await this.twitterClient.interaction.stop();
    }

    if (this.twitterClient?.timeline) {
      await this.twitterClient.timeline.stop();
    }

    if (this.twitterClient?.discovery) {
      await this.twitterClient.discovery.stop();
    }

    logger.log("Twitter service stopped");
  }
}

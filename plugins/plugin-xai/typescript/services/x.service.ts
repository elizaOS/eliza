import { Service, type IAgentRuntime, logger, parseBooleanFromText } from "@elizaos/core";
import { TwitterInteractionClient } from "../interactions";
import { TwitterPostClient } from "../post";
import { TwitterTimelineClient } from "../timeline";
import { TwitterDiscoveryClient } from "../discovery";
import { validateXConfig } from "../environment";
import { ClientBase } from "../base";
import type { IXClient } from "../types";
import { getSetting } from "../utils/settings";

/**
 * X Client Instance - orchestrates all X (Twitter) functionality:
 * - client: base operations (auth, timeline caching)
 * - post: autonomous posting
 * - interaction: mentions and replies
 * - timeline: actions (likes, reposts, replies)
 * - discovery: content discovery and engagement
 */
export class XClientInstance implements IXClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
  timeline?: TwitterTimelineClient;
  discovery?: TwitterDiscoveryClient;

  constructor(runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.client = new ClientBase(runtime, state);

    // Posting
    const postEnabled = parseBooleanFromText(getSetting(runtime, "X_ENABLE_POST"));
    if (postEnabled) {
      logger.info("X posting ENABLED");
      this.post = new TwitterPostClient(this.client, runtime, state);
    }

    // Replies/interactions
    const repliesEnabled = getSetting(runtime, "X_ENABLE_REPLIES") !== "false";
    if (repliesEnabled) {
      logger.info("X replies ENABLED");
      this.interaction = new TwitterInteractionClient(this.client, runtime, state);
    }

    // Timeline actions
    const actionsEnabled = getSetting(runtime, "X_ENABLE_ACTIONS") === "true";
    if (actionsEnabled) {
      logger.info("X timeline actions ENABLED");
      this.timeline = new TwitterTimelineClient(this.client, runtime, state);
    }

    // Discovery
    const discoveryEnabled =
      getSetting(runtime, "X_ENABLE_DISCOVERY") === "true" ||
      (actionsEnabled && getSetting(runtime, "X_ENABLE_DISCOVERY") !== "false");
    if (discoveryEnabled) {
      logger.info("X discovery ENABLED");
      this.discovery = new TwitterDiscoveryClient(this.client, runtime, state);
    }
  }
}

export class XService extends Service {
  static serviceType = "x";
  capabilityDescription = "Send and receive posts on X (Twitter)";

  public xClient?: XClientInstance;

  static async start(runtime: IAgentRuntime): Promise<XService> {
    const service = new XService();
    service.runtime = runtime;

    await validateXConfig(runtime);
    logger.log("✅ X configuration validated");

    service.xClient = new XClientInstance(runtime, {});
    await service.xClient.client.init();

    if (service.xClient.post) {
      logger.log("📮 Starting X post client...");
      await service.xClient.post.start();
    }

    if (service.xClient.interaction) {
      logger.log("💬 Starting X interaction client...");
      await service.xClient.interaction.start();
    }

    if (service.xClient.timeline) {
      logger.log("📊 Starting X timeline client...");
      await service.xClient.timeline.start();
    }

    if (service.xClient.discovery) {
      logger.log("🔍 Starting X discovery client...");
      await service.xClient.discovery.start();
    }

    logger.log("✅ X service started");
    return service;
  }

  async stop(): Promise<void> {
    if (this.xClient?.post) await this.xClient.post.stop();
    if (this.xClient?.interaction) await this.xClient.interaction.stop();
    if (this.xClient?.timeline) await this.xClient.timeline.stop();
    if (this.xClient?.discovery) await this.xClient.discovery.stop();
    logger.log("X service stopped");
  }
}

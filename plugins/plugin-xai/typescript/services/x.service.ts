import { type IAgentRuntime, logger, parseBooleanFromText, Service } from "@elizaos/core";
import { ClientBase } from "../base";
import { XDiscoveryClient } from "../discovery";
import { validateXConfig } from "../environment";
import { XInteractionClient } from "../interactions";
import { XPostClient } from "../post";
import { XTimelineClient } from "../timeline";
import type { IXClient } from "../types";
import { getSetting } from "../utils/settings";

export class XClientInstance implements IXClient {
  client: ClientBase;
  post?: XPostClient;
  interaction?: XInteractionClient;
  timeline?: XTimelineClient;
  discovery?: XDiscoveryClient;

  constructor(runtime: IAgentRuntime, state: Record<string, unknown>) {
    this.client = new ClientBase(runtime, state);

    const postEnabled = parseBooleanFromText(getSetting(runtime, "X_ENABLE_POST"));
    if (postEnabled) {
      logger.info("X posting ENABLED");
      this.post = new XPostClient(this.client, runtime, state);
    }

    const repliesEnabled = getSetting(runtime, "X_ENABLE_REPLIES") !== "false";
    if (repliesEnabled) {
      logger.info("X replies ENABLED");
      this.interaction = new XInteractionClient(this.client, runtime, state);
    }

    const actionsEnabled = getSetting(runtime, "X_ENABLE_ACTIONS") === "true";
    if (actionsEnabled) {
      logger.info("X timeline actions ENABLED");
      this.timeline = new XTimelineClient(this.client, runtime, state);
    }

    const discoveryEnabled =
      getSetting(runtime, "X_ENABLE_DISCOVERY") === "true" ||
      (actionsEnabled && getSetting(runtime, "X_ENABLE_DISCOVERY") !== "false");
    if (discoveryEnabled) {
      logger.info("X discovery ENABLED");
      this.discovery = new XDiscoveryClient(this.client, runtime, state);
    }
  }
}

export class XService extends Service {
  static serviceType = "x";
  capabilityDescription = "Send and receive posts on X (formerly Twitter)";

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

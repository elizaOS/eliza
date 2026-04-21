import { type IAgentRuntime, Service } from "@elizaos/core";

export class LifeOpsBrowserPluginService extends Service {
  static serviceType = "lifeops_browser_plugin";

  capabilityDescription =
    "Surfaces the user's personal LifeOps Browser state and creates browser sessions for their Chrome and Safari companions.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<LifeOpsBrowserPluginService> {
    return new LifeOpsBrowserPluginService(runtime);
  }

  async stop(): Promise<void> {
    // No resources to clean up.
  }
}

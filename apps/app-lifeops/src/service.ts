import { type IAgentRuntime, Service } from "@elizaos/core";

export class BrowserBridgePluginService extends Service {
  static serviceType = "lifeops_browser_plugin";

  capabilityDescription =
    "Surfaces the user's personal Agent Browser Bridge state and creates browser sessions for their Chrome and Safari companions.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<BrowserBridgePluginService> {
    return new BrowserBridgePluginService(runtime);
  }

  async stop(): Promise<void> {
    // No resources to clean up.
  }
}

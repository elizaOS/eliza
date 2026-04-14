import { type IAgentRuntime, Service } from "@elizaos/core";

export class AppBrowserWorkspaceService extends Service {
  static serviceType = "app_browser_workspace";

  capabilityDescription =
    "Controls Eliza browser workspace tabs across the desktop bridge and web iframe workspace, alongside Steward wallet signing requests.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<AppBrowserWorkspaceService> {
    return new AppBrowserWorkspaceService(runtime);
  }
}

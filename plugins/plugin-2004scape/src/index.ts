import { gatePluginSessionForHostedApp } from "@elizaos/agent/services/app-session-gate";
import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { rsSdkActions } from "./actions/index.js";
import { rsSdkProviders } from "./providers/index.js";
import { RsSdkGameService } from "./services/game-service.js";

const rawRs2004scapePlugin: Plugin = {
  name: "@elizaos/plugin-2004scape",
  description:
    "Autonomous 2004scape game agent — WebSocket SDK, LLM-driven game loop, RS_2004_WALK_TO + 6 routers, and JSON world-context providers.",

  services: [RsSdkGameService as ServiceClass],
  actions: rsSdkActions,
  providers: rsSdkProviders,
  views: [
    {
      id: "2004scape",
      label: "2004scape",
      description: "2004scape game operator surface — agent controls and session management",
      icon: "Gamepad2",
      path: "/2004scape",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TwoThousandFourScapeOperatorSurface",
      tags: ["game", "runescape", "2004scape"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<RsSdkGameService>(RsSdkGameService.serviceType);
    await svc?.stop();
  },
};

export const rs2004scapePlugin: Plugin = gatePluginSessionForHostedApp(
  rawRs2004scapePlugin,
  "@elizaos/plugin-2004scape",
);

export default rs2004scapePlugin;

export type { GatewayHandle, GatewayOptions } from "./gateway/index.js";
export { startGateway } from "./gateway/index.js";
export * from "./routes.js";
export { BotActions } from "./sdk/actions.js";
export { BotSDK } from "./sdk/index.js";
export type * from "./sdk/types.js";
export { BotManager } from "./services/bot-manager.js";
// Re-exports for direct access
export { RsSdkGameService } from "./services/game-service.js";
export * from "./ui/index.js";

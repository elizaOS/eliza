import { gatePluginSessionForHostedApp } from "@elizaos/agent";
import type { Plugin, ServiceClass } from "@elizaos/core";
import { rsSdkActions } from "./actions/index.js";
import { rsSdkProviders } from "./providers/index.js";
import { RsSdkGameService } from "./services/game-service.js";

const rawRs2004scapePlugin: Plugin = {
  name: "@elizaos/app-2004scape",
  description:
    "Autonomous 2004scape game agent — WebSocket SDK, LLM-driven game loop, RS_2004_WALK_TO + 6 routers, and JSON world-context providers.",

  services: [RsSdkGameService as ServiceClass],
  actions: rsSdkActions,
  providers: rsSdkProviders,
};

export const rs2004scapePlugin: Plugin = gatePluginSessionForHostedApp(
  rawRs2004scapePlugin,
  "@elizaos/app-2004scape",
);

export default rs2004scapePlugin;

export type { GatewayHandle, GatewayOptions } from "./gateway/index.js";
export { startGateway } from "./gateway/index.js";
export { BotActions } from "./sdk/actions.js";
export { BotSDK } from "./sdk/index.js";
export type * from "./sdk/types.js";
export { BotManager } from "./services/bot-manager.js";
// Re-exports for direct access
export { RsSdkGameService } from "./services/game-service.js";

import type { Plugin, ServiceClass } from "@elizaos/core";
import {
  gatePluginSessionForHostedApp,
} from "@elizaos/agent";
import { RsSdkGameService } from "./services/game-service.js";
import { rsSdkProviders } from "./providers/index.js";
import { rsSdkActions } from "./actions/index.js";

const rawRs2004scapePlugin: Plugin = {
  name: "@elizaos/app-2004scape",
  description:
    "Autonomous 2004scape game agent — WebSocket SDK, LLM-driven game loop, 32 game actions, and 4 world-context providers.",

  services: [RsSdkGameService as ServiceClass],
  actions: rsSdkActions,
  providers: rsSdkProviders,
};

export const rs2004scapePlugin: Plugin = gatePluginSessionForHostedApp(
  rawRs2004scapePlugin,
  "@elizaos/app-2004scape",
);

export default rs2004scapePlugin;

// Re-exports for direct access
export { RsSdkGameService } from "./services/game-service.js";
export { BotManager } from "./services/bot-manager.js";
export { BotSDK } from "./sdk/index.js";
export { BotActions } from "./sdk/actions.js";
export { startGateway } from "./gateway/index.js";
export type { GatewayHandle, GatewayOptions } from "./gateway/index.js";
export type * from "./sdk/types.js";

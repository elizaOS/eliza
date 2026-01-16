import type { IAgentRuntime, Plugin, Provider } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { z } from "zod";

export * from "./actions/index.js";
export * from "./protocol.js";
export * from "./providers/index.js";
export * from "./services/minecraft-service.js";
export * from "./services/process-manager.js";
export * from "./services/waypoints-service.js";
export * from "./services/websocket-client.js";
export * from "./types.js";

import {
  minecraftAttackAction,
  minecraftChatAction,
  minecraftConnectAction,
  minecraftControlAction,
  minecraftDigAction,
  minecraftDisconnectAction,
  minecraftGotoAction,
  minecraftLookAction,
  minecraftPlaceAction,
  minecraftScanAction,
  minecraftStopAction,
  minecraftWaypointDeleteAction,
  minecraftWaypointGotoAction,
  minecraftWaypointListAction,
  minecraftWaypointSetAction,
} from "./actions/index.js";
import {
  minecraftVisionProvider,
  minecraftWaypointsProvider,
  minecraftWorldStateProvider,
} from "./providers/index.js";
import { MinecraftService } from "./services/minecraft-service.js";
import { WaypointsService } from "./services/waypoints-service.js";

const configSchema = z.object({
  MC_SERVER_PORT: z.string().optional().default("3457"),
  MC_HOST: z.string().optional().default("127.0.0.1"),
  MC_PORT: z.string().optional().default("25565"),
  MC_USERNAME: z.string().optional(),
  MC_AUTH: z.string().optional().default("offline"),
  MC_VERSION: z.string().optional(),
});

// Backward-compatible provider reference.
const minecraftStateProvider: Provider = minecraftWorldStateProvider;

export const minecraftPlugin: Plugin = {
  name: "plugin-minecraft",
  description: "Minecraft automation plugin (Mineflayer bridge)",
  config: {
    MC_SERVER_PORT: process.env.MC_SERVER_PORT ?? "3457",
    MC_HOST: process.env.MC_HOST ?? "127.0.0.1",
    MC_PORT: process.env.MC_PORT ?? "25565",
    MC_USERNAME: process.env.MC_USERNAME ?? null,
    MC_AUTH: process.env.MC_AUTH ?? "offline",
    MC_VERSION: process.env.MC_VERSION ?? null,
  },
  async init(config: Record<string, string | null>, _runtime: IAgentRuntime) {
    logger.info("Initializing Minecraft plugin");
    const validatedConfig = await configSchema.parseAsync(config);
    for (const [key, value] of Object.entries(validatedConfig)) {
      if (value !== undefined && value !== null) {
        process.env[key] = String(value);
      }
    }
    logger.info("Minecraft plugin initialized");
  },
  services: [MinecraftService, WaypointsService],
  actions: [
    minecraftConnectAction,
    minecraftDisconnectAction,
    minecraftChatAction,
    minecraftGotoAction,
    minecraftStopAction,
    minecraftLookAction,
    minecraftControlAction,
    minecraftDigAction,
    minecraftPlaceAction,
    minecraftAttackAction,
    minecraftScanAction,
    minecraftWaypointSetAction,
    minecraftWaypointListAction,
    minecraftWaypointGotoAction,
    minecraftWaypointDeleteAction,
  ],
  providers: [
    minecraftStateProvider,
    minecraftWaypointsProvider,
    minecraftVisionProvider,
  ],
};

export default minecraftPlugin;

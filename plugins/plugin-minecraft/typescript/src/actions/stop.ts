import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

export const minecraftStopAction: Action = {
  name: "MC_STOP",
  similes: ["MINECRAFT_STOP", "STOP_PATHFINDER", "STOP_MOVING"],
  description: "Stop pathfinding / movement goals.",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    if (!service)
      return { text: "Minecraft service is not available", success: false };
    try {
      await service.request("stop", {});
      const content: Content = {
        text: "Stopped movement.",
        actions: ["MC_STOP"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to stop: ${msg}`,
        actions: ["MC_STOP"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

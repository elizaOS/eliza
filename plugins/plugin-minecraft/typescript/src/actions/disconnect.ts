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

export const minecraftDisconnectAction: Action = {
  name: "MC_DISCONNECT",
  similes: ["MINECRAFT_DISCONNECT", "LEAVE_SERVER", "QUIT_MINECRAFT"],
  description: "Disconnect the Mineflayer bot from the Minecraft server",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service?.getCurrentSession());
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
    if (!service) {
      return { text: "Minecraft service is not available", success: false };
    }
    const session = service.getCurrentSession();
    if (!session) {
      return { text: "No Minecraft bot is connected", success: false };
    }

    try {
      await service.destroyBot(session.botId);
      const content: Content = {
        text: "Disconnected Minecraft bot.",
        actions: ["MC_DISCONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: true,
        values: { connected: false },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to disconnect Minecraft bot: ${msg}`,
        actions: ["MC_DISCONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

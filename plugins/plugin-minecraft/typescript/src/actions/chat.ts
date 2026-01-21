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

export const minecraftChatAction: Action = {
  name: "MC_CHAT",
  similes: ["MINECRAFT_CHAT", "SAY_IN_MINECRAFT", "CHAT"],
  description: "Send a chat message in Minecraft as the bot",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service) && (message.content.text ?? "").trim().length > 0;
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
    const text = (message.content.text ?? "").trim();
    if (!text) return { text: "No chat message provided", success: false };

    try {
      await service.chat(text);
      const content: Content = {
        text: `Sent Minecraft chat: ${text}`,
        actions: ["MC_CHAT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: true,
        values: { sent: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to send Minecraft chat: ${msg}`,
        actions: ["MC_CHAT"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

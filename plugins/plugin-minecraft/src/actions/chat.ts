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
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";

export const minecraftChatAction: Action = {
  name: "MC_CHAT",
  similes: ["MINECRAFT_CHAT", "SAY_IN_MINECRAFT", "CHAT"],
  description: "Send a chat message in Minecraft as the bot",
  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["chat"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:chat)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      message: Memory
    ): Promise<boolean> => {
      const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
      return Boolean(service) && (message.content.text ?? "").trim().length > 0;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
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

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
import { z } from "zod";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";

const connectOverridesSchema = z
  .object({
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    username: z.string().optional(),
    auth: z.enum(["offline", "microsoft"]).optional(),
    version: z.string().optional(),
  })
  .passthrough();

function parseOverrides(text: string): Record<string, string | number> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const parsed = JSON.parse(trimmed) as Record<string, string | number>;
    const validated = connectOverridesSchema.parse(parsed);
    const out: Record<string, string | number> = {};
    if (typeof validated.host === "string") out.host = validated.host;
    if (typeof validated.port === "number") out.port = validated.port;
    if (typeof validated.username === "string") out.username = validated.username;
    if (typeof validated.auth === "string") out.auth = validated.auth;
    if (typeof validated.version === "string") out.version = validated.version;
    return out;
  } catch {
    return {};
  }
}

export const minecraftConnectAction: Action = {
  name: "MC_CONNECT",
  similes: ["MINECRAFT_CONNECT", "JOIN_SERVER", "CONNECT_TO_MINECRAFT"],
  description: "Connect the Mineflayer bot to a Minecraft server",
  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["connect"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:connect)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
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

    const __avLegacyValidate = async (runtime: IAgentRuntime): Promise<boolean> => {
      const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
      return Boolean(service);
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

    try {
      const overrides = parseOverrides(message.content.text ?? "");
      const session = await service.createBot(overrides);

      const content: Content = {
        text: `Connected Minecraft bot (botId=${session.botId}).`,
        actions: ["MC_CONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: true,
        data: { botId: session.botId },
        values: { connected: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to connect Minecraft bot: ${msg}`,
        actions: ["MC_CONNECT"],
        source: message.content.source,
      };
      await callback?.(content);
      return {
        text: content.text ?? "",
        success: false,
        data: { error: msg },
        values: { connected: false },
      };
    }
  },
};

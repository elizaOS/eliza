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

const lookSchema = z.object({ yaw: z.number(), pitch: z.number() });

function parseLook(text: string): { yaw: number; pitch: number } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { yaw?: number; pitch?: number };
      return lookSchema.parse(parsed);
    } catch {
      return null;
    }
  }
  const m = trimmed.match(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const yaw = Number(m[1]);
  const pitch = Number(m[2]);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  return { yaw, pitch };
}

export const minecraftLookAction: Action = {
  name: "MC_LOOK",
  similes: ["MINECRAFT_LOOK", "TURN_HEAD"],
  description: "Look to yaw/pitch (radians). Provide 'yaw pitch' or JSON {yaw,pitch}.",
  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["look"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:look)\b/i;
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
      return Boolean(service) && Boolean(parseLook(message.content.text ?? ""));
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
    if (!service) return { text: "Minecraft service is not available", success: false };
    const req = parseLook(message.content.text ?? "");
    if (!req) return { text: "Missing yaw/pitch", success: false };

    try {
      await service.request("look", { yaw: req.yaw, pitch: req.pitch });
      const content: Content = {
        text: "Adjusted view.",
        actions: ["MC_LOOK"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to look: ${msg}`,
        actions: ["MC_LOOK"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

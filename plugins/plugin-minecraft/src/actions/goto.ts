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
import { extractVec3 } from "./utils.js";

export const minecraftGotoAction: Action = {
  name: "MC_GOTO",
  similes: ["MINECRAFT_GOTO", "WALK_TO", "MOVE_TO_COORDS"],
  description:
    'Pathfind to a target (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10,"y":64,"z":-20}.',
  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["goto"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:goto)\b/i;
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
      return Boolean(service) && Boolean(extractVec3(message.content.text ?? ""));
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

    const vec = extractVec3(message.content.text ?? "");
    if (!vec) return { text: "Missing coordinates (x y z)", success: false };

    try {
      await service.request("goto", { x: vec.x, y: vec.y, z: vec.z });
      const content: Content = {
        text: `Moving to (${vec.x}, ${vec.y}, ${vec.z}).`,
        actions: ["MC_GOTO"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to pathfind: ${msg}`,
        actions: ["MC_GOTO"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

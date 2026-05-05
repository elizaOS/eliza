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
import { matchPlannerValidateGate } from "./action-validate-gate.js";
import { extractVec3 } from "./utils.js";

export const minecraftDigAction: Action = {
  name: "MC_DIG",
  similes: ["MINECRAFT_DIG", "MINE_BLOCK", "BREAK_BLOCK"],
  description:
    'Dig/break the block at (x y z). Provide coordinates like \'10 64 -20\' or JSON {"x":10,"y":64,"z":-20}.',
  descriptionCompressed: "dig/break block (x y z) provide coordinate like 10 64 - 20 JSON x: 10, y: 64, z: - 20",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    matchPlannerValidateGate(runtime, message, state, {
      keywords: ["dig"],
      regex: /\b(?:dig)\b/i,
      legacyValidate: async (rt, msg) => {
        const service = rt.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
        return Boolean(service) && Boolean(extractVec3(msg.content.text ?? ""));
      },
    }),
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
      const data = await service.request("dig", {
        x: vec.x,
        y: vec.y,
        z: vec.z,
      });
      const blockName = typeof data.blockName === "string" ? data.blockName : "block";
      const content: Content = {
        text: `Dug ${blockName} at (${vec.x}, ${vec.y}, ${vec.z}).`,
        actions: ["MC_DIG"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to dig: ${msg}`,
        actions: ["MC_DIG"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};

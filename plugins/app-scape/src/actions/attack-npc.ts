/**
 * ATTACK_NPC — engage a nearby NPC in combat by its instance id.
 *
 * Expected LLM response format:
 *
 *   action: ATTACK_NPC
 *   npcId: 42
 *
 * NPC instance ids come from the `SCAPE_NEARBY` provider's
 * `npcs[].id` column. The server pathfinds the agent into attack
 * range automatically via `PlayerManager.attackNpcAsAgent`.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ScapeGameService } from "../services/game-service.js";
import { hasActionRequest, resolveActionText } from "../shared-state.js";
import { extractParamInt } from "./param-parser.js";

export const attackNpc: Action = {
  name: "ATTACK_NPC",
  description:
    "Engage a nearby NPC in combat by its instance id. The server pathfinds the agent into attack range automatically.",
  descriptionCompressed: "Attack NPC by id.",
  contexts: ["game", "automation", "world", "state"],
  roleGate: { minRole: "ADMIN" },
  similes: ["FIGHT_NPC", "KILL_NPC", "ENGAGE"],
  examples: [],
  parameters: [
    {
      name: "npcId",
      description: "Nearby NPC instance id from the SCAPE_NEARBY provider.",
      descriptionCompressed: "NPC id.",
      required: true,
      schema: { type: "number" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionRequest(message, "ATTACK_NPC");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
    if (!service) {
      const err = "'scape game service not available.";
      callback?.({ text: err, action: "ATTACK_NPC" });
      return { success: false, text: err };
    }

    const text = resolveActionText(message);
    const npcId = extractParamInt(text, "npcId") ?? extractParamInt(text, "id");
    if (npcId === null) {
      const err = "ATTACK_NPC requires npcId: N.";
      callback?.({ text: err, action: "ATTACK_NPC" });
      return { success: false, text: err };
    }

    try {
      const result = await service.executeAction({
        action: "attackNpc",
        npcId,
      });
      const displayText =
        result.message ?? (result.success ? "engaging" : "attack failed");
      callback?.({ text: displayText, action: "ATTACK_NPC" });
      return { success: result.success, text: displayText };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown attack failure.";
      const displayText = `attack failed: ${message}`;
      callback?.({ text: displayText, action: "ATTACK_NPC" });
      return {
        success: false,
        text: displayText,
        error: message,
        data: { action: "attackNpc", npcId },
      };
    }
  },
};

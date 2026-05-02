/**
 * ATTACK_NPC — engage a nearby NPC in combat by its instance id.
 *
 * Expected LLM response format:
 *
 *   <action>ATTACK_NPC</action>
 *   <npcId>42</npcId>
 *
 * The LLM gets NPC instance ids from the `SCAPE_NEARBY` provider,
 * which lists them in the `npcs[].id` column each step.
 *
 * Server-side: `BotSdkActionRouter.attackNpc` →
 * `PlayerManager.attackNpcAsAgent` →
 * `NpcCombatInteractionHandler.startNpcAttack`. The server walks the
 * agent into attack range on its own; the LLM does not need to
 * walkTo the NPC first.
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
import { hasActionTag, resolveActionText } from "../shared-state.js";
import { extractParamInt } from "./param-parser.js";

export const attackNpc: Action = {
  name: "ATTACK_NPC",
  description:
    "Engage a nearby NPC in combat by its instance id. The server pathfinds the agent into attack range automatically.",
  descriptionCompressed: "Attack nearby NPC by name.",
  similes: ["FIGHT_NPC", "KILL_NPC", "ENGAGE"],
  examples: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionTag(message, "ATTACK_NPC");
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
      const err = "ATTACK_NPC requires <npcId>N</npcId>.";
      callback?.({ text: err, action: "ATTACK_NPC" });
      return { success: false, text: err };
    }

    const result = await service.executeAction({
      action: "attackNpc",
      npcId,
    });
    const displayText =
      result.message ?? (result.success ? "engaging" : "attack failed");
    callback?.({ text: displayText, action: "ATTACK_NPC" });
    return { success: result.success, text: displayText };
  },
};

/**
 * EAT_FOOD — consume a food item in inventory to restore hitpoints.
 *
 * Expected LLM response format:
 *
 *   <action>EAT_FOOD</action>
 *   <slot>0</slot>
 *
 * `slot` is optional; if omitted, the server picks the first item in
 * the agent's inventory. The LLM should usually specify a slot based
 * on the `SCAPE_INVENTORY` provider.
 *
 * Server-side: `BotSdkActionRouter.eatFood` →
 * `InventoryActionHandler.executeInventoryConsumeAction`. Food
 * healing is applied by the item's associated effect script.
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

export const eatFood: Action = {
  name: "EAT_FOOD",
  description:
    "Eat a food item from an inventory slot to restore hitpoints. Prioritize this when HP is low.",
  descriptionCompressed: "Eat food from inventory.",
  similes: ["CONSUME_FOOD", "HEAL", "EAT"],
  examples: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionTag(message, "EAT_FOOD");
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
      callback?.({ text: err, action: "EAT_FOOD" });
      return { success: false, text: err };
    }

    const text = resolveActionText(message);
    const slot = extractParamInt(text, "slot");
    const result = await service.executeAction({
      action: "eatFood",
      slot: slot ?? undefined,
    });
    const displayText =
      result.message ?? (result.success ? "ate" : "eat failed");
    callback?.({ text: displayText, action: "EAT_FOOD" });
    return { success: result.success, text: displayText };
  },
};

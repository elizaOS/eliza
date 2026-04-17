/**
 * DROP_ITEM — remove an item from the agent's inventory and spawn it
 * on the ground at the agent's current tile.
 *
 * Expected LLM response format:
 *
 *   <action>DROP_ITEM</action>
 *   <slot>3</slot>
 *
 * `slot` is the inventory slot index (0..27). The LLM gets slot
 * numbers from the `SCAPE_INVENTORY` provider.
 *
 * Server-side: `BotSdkActionRouter.dropItem` →
 * `InventoryService.consumeItem` + `GroundItemManager.spawn`.
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

export const dropItem: Action = {
  name: "DROP_ITEM",
  description:
    "Drop an item from an inventory slot onto the ground at your feet. Useful when inventory is full or you don't need an item.",
  descriptionCompressed: "Drop inventory item.",
  similes: ["DISCARD", "THROW_AWAY", "DUMP"],
  examples: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionTag(message, "DROP_ITEM");
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
      callback?.({ text: err, action: "DROP_ITEM" });
      return { success: false, text: err };
    }

    const text = resolveActionText(message);
    const slot = extractParamInt(text, "slot");
    if (slot === null) {
      const err = "DROP_ITEM requires <slot>N</slot>.";
      callback?.({ text: err, action: "DROP_ITEM" });
      return { success: false, text: err };
    }

    const result = await service.executeAction({
      action: "dropItem",
      slot,
    });
    const displayText =
      result.message ?? (result.success ? "dropped" : "drop failed");
    callback?.({ text: displayText, action: "DROP_ITEM" });
    return { success: result.success, text: displayText };
  },
};

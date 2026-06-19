/**
 * inventory provider — packs the agent's inventory + equipment into
 * compact JSON context.
 *
 * Empty slots are elided (PR 5 may surface free-slot count as a
 * separate field once the LLM has a reason to care about it).
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import type { ScapeGameService } from "../services/game-service.js";

const INVENTORY_ITEM_LIMIT = 28;
const EQUIPMENT_ITEM_LIMIT = 14;

export const inventoryProvider: Provider = {
  name: "SCAPE_INVENTORY",
  description:
    "Agent's current inventory and equipped items. Empty slots elided.",
  descriptionCompressed: "Inventory and equipped items.",
  contexts: ["game", "automation", "world", "state"],
  contextGate: { anyOf: ["game", "automation", "world", "state"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const service = runtime.getService(
        "scape_game",
      ) as ScapeGameService | null;
      if (!service) return { text: "" };
      const snapshot = service.getPerception();
      if (!snapshot) return { text: "" };

      const inv = snapshot.inventory;
      const eq = snapshot.equipment;

      return {
        text: JSON.stringify({
          scape_inventory: {
            count: inv.length,
            capacity: 28,
            items: inv.slice(0, INVENTORY_ITEM_LIMIT).map((item) => ({
              slot: item.slot,
              itemId: item.itemId,
              name: item.name,
              count: item.count,
            })),
            worn: eq.slice(0, EQUIPMENT_ITEM_LIMIT).map((item) => ({
              slot: item.slot,
              itemId: item.itemId,
              name: item.name,
              count: item.count,
            })),
          },
        }),
      };
    } catch (error) {
      return {
        text: JSON.stringify({
          scape_inventory: {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          },
        }),
      };
    }
  },
};

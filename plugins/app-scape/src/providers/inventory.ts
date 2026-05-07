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

export const inventoryProvider: Provider = {
  name: "SCAPE_INVENTORY",
  description:
    "Agent's current inventory and equipped items. Empty slots elided.",
  descriptionCompressed: "Inventory and equipped items.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
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
          items: inv.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            name: item.name,
            count: item.count,
          })),
          worn: eq.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            name: item.name,
            count: item.count,
          })),
        },
      }),
    };
  },
};

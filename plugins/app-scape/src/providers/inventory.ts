/**
 * inventory provider — packs the agent's inventory + equipment into
 * TOON tables. This is where TOON's header-row + CSV-data layout pays
 * off dramatically: a full 28-slot inventory goes from ~280 JSON
 * tokens to ~90 TOON tokens.
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
import { encode } from "@toon-format/toon";

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

    const sections: string[] = [];

    if (inv.length === 0) {
      sections.push("# INVENTORY\n(empty)");
    } else {
      sections.push(
        `# INVENTORY (${inv.length}/28)\n${encode({
          items: inv.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            name: item.name,
            count: item.count,
          })),
        })}`,
      );
    }

    if (eq.length === 0) {
      sections.push("# EQUIPMENT\n(nothing worn)");
    } else {
      sections.push(
        `# EQUIPMENT\n${encode({
          worn: eq.map((item) => ({
            slot: item.slot,
            itemId: item.itemId,
            name: item.name,
            count: item.count,
          })),
        })}`,
      );
    }

    return { text: sections.join("\n\n") };
  },
};

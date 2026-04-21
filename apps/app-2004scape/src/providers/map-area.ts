import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { BotState } from "../sdk/types.js";
import { identifyArea } from "../data/areas.js";

export const mapAreaProvider: Provider = {
  name: "RS_SDK_MAP_AREA",
  description:
    "Identifies the bot's current map area and lists features, NPCs, and travel destinations.",
  descriptionCompressed: "Current area: features, NPCs, travel destinations.",

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<string> {
    const service = runtime.getService("rs_2004scape") as
      | { getBotState(): BotState | null }
      | undefined;
    const state = service?.getBotState?.();
    if (!state?.connected || !state.inGame || !state.player) {
      return "[RS_SDK_MAP_AREA] Not in game.";
    }

    const { worldX: x, worldZ: z } = state.player;
    const area = identifyArea(x, z);

    if (!area) {
      return `[RS_SDK_MAP_AREA] Unknown area at (${x}, ${z}). Explore cautiously.`;
    }

    let output = `[RS_SDK_MAP_AREA] Current area: ${area.name} (${x}, ${z})\n`;
    output += `Features: ${area.features.join(", ")}\n`;
    output += `Notable NPCs: ${area.npcs.join(", ")}\n`;
    output += `Adjacent areas: ${area.adjacentAreas.join(", ")}\n`;

    if (area.travelCoords.length > 0) {
      output += "Travel coordinates:\n";
      for (const coord of area.travelCoords) {
        const dist = Math.max(Math.abs(coord.x - x), Math.abs(coord.z - z));
        output += `  ${coord.name}: (${coord.x}, ${coord.z}) — ${dist} tiles away\n`;
      }
    }

    return output;
  },
};

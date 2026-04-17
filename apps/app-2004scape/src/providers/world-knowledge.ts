import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import type { BotState } from "../sdk/types.js";
import { findNearestBank } from "../data/banks.js";
import { getTrainingRecommendations } from "../data/training.js";

export const worldKnowledgeProvider: Provider = {
  name: "RS_SDK_WORLD_KNOWLEDGE",
  description:
    "Game world knowledge: nearest bank, skill training recommendations, and important warnings.",
  descriptionCompressed: "Nearest bank, skill training tips, warnings.",

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
      return "[RS_SDK_WORLD_KNOWLEDGE] Not in game.";
    }

    const { worldX: x, worldZ: z } = state.player;
    let output = "[RS_SDK_WORLD_KNOWLEDGE]\n";

    // Nearest bank
    const bank = findNearestBank(x, z);
    output += `Nearest bank: ${bank.name} (${bank.distance} tiles away at ${bank.x}, ${bank.z})\n`;

    // Training recommendations for current skills
    const trainable = state.skills.filter((s) =>
      ["Woodcutting", "Mining", "Fishing", "Attack", "Strength", "Defence", "Cooking", "Smithing"].includes(s.name),
    );

    if (trainable.length > 0) {
      output += "\nTraining recommendations:\n";
      for (const skill of trainable) {
        const recs = getTrainingRecommendations(skill.name, skill.level);
        if (recs.length > 0) {
          const rec = recs[0];
          output += `  ${skill.name} (lvl ${skill.level}): ${rec.method} at ${rec.location}`;
          if (rec.xpPerHour) output += ` (${rec.xpPerHour}/hr)`;
          output += "\n";
        }
      }
    }

    // Important warnings based on position
    const warnings: string[] = [];

    // Dark wizards near Varrock
    if (x >= 3210 && x <= 3240 && z >= 3360 && z <= 3390) {
      warnings.push(
        "DANGER: Dark wizards area! They are aggressive and can kill low-level players.",
      );
    }

    // Wilderness warning
    if (z >= 3520) {
      warnings.push(
        "WARNING: You are near or in the Wilderness. Other players can attack you here.",
      );
    }

    // Al Kharid toll gate
    if (
      x >= 3258 &&
      x <= 3270 &&
      z >= 3225 &&
      z <= 3235 &&
      state.player.combatLevel < 10
    ) {
      warnings.push(
        "Note: The Al Kharid toll gate costs 10gp to pass through (or complete Prince Ali Rescue quest).",
      );
    }

    // No food in combat
    if (
      state.player.inCombat &&
      !state.inventory.some((item) =>
        ["shrimp", "anchovies", "bread", "meat", "chicken", "trout", "salmon", "tuna", "lobster", "swordfish", "cake", "pie"].some(
          (food) => item.name.toLowerCase().includes(food),
        ),
      )
    ) {
      warnings.push(
        "WARNING: You are in combat with no food! Walk away immediately.",
      );
    }

    if (warnings.length > 0) {
      output += `\n⚠ Warnings:\n${warnings.map((w) => `  ${w}`).join("\n")}\n`;
    }

    return output;
  },
};

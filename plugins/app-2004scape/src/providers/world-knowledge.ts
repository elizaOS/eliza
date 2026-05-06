import {
  encodeToonValue,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { BotState } from "../sdk/types.js";

const BANKS = [
  { name: "Lumbridge bank", x: 3208, z: 3220 },
  { name: "Varrock east bank", x: 3253, z: 3420 },
  { name: "Draynor bank", x: 3093, z: 3243 },
  { name: "Falador west bank", x: 2946, z: 3368 },
  { name: "Al Kharid bank", x: 3269, z: 3167 },
];

const TRAINING_METHODS: Record<
  string,
  Array<{ minLevel: number; method: string; location: string }>
> = {
  woodcutting: [
    { minLevel: 1, method: "normal trees", location: "Lumbridge woods" },
    { minLevel: 15, method: "oak trees", location: "Varrock road" },
    { minLevel: 30, method: "willow trees", location: "Draynor" },
  ],
  mining: [
    { minLevel: 1, method: "copper or tin", location: "Varrock east mine" },
    { minLevel: 15, method: "iron rocks", location: "Varrock east mine" },
  ],
  fishing: [
    { minLevel: 1, method: "small net shrimp", location: "Lumbridge swamp" },
    { minLevel: 20, method: "fly fishing", location: "Barbarian Village" },
  ],
  attack: [{ minLevel: 1, method: "chickens or cows", location: "Lumbridge" }],
  strength: [
    { minLevel: 1, method: "chickens or cows", location: "Lumbridge" },
  ],
  defence: [{ minLevel: 1, method: "chickens or cows", location: "Lumbridge" }],
  cooking: [
    { minLevel: 1, method: "cook shrimp or meat", location: "range or fire" },
  ],
  smithing: [
    { minLevel: 1, method: "bronze bars", location: "furnace and anvil" },
  ],
};

const FOOD_ITEMS = [
  "shrimp",
  "anchovies",
  "bread",
  "meat",
  "chicken",
  "trout",
  "salmon",
  "tuna",
  "lobster",
  "swordfish",
  "cake",
  "pie",
];

function chebyshevDistance(ax: number, az: number, bx: number, bz: number) {
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}

function nearestBank(x: number, z: number) {
  return BANKS.map((bank) => ({
    ...bank,
    distance: chebyshevDistance(x, z, bank.x, bank.z),
  })).sort((a, b) => a.distance - b.distance)[0];
}

function trainingRecommendation(skillName: string, level: number) {
  const methods = TRAINING_METHODS[skillName.toLowerCase()] ?? [];
  return methods
    .filter((method) => level >= method.minLevel)
    .sort((a, b) => b.minLevel - a.minLevel)[0];
}

export const worldKnowledgeProvider: Provider = {
  name: "RS_SDK_WORLD_KNOWLEDGE",
  description:
    "TOON game world knowledge: nearest bank, skill training recommendations, and warnings.",
  descriptionCompressed: "TOON nearest bank, skill tips, warnings.",

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const service = runtime.getService("rs_2004scape") as unknown as {
      getBotState(): BotState | null;
    } | null;
    const state = service?.getBotState?.();
    if (!state?.connected || !state.inGame || !state.player) {
      return {
        text: encodeToonValue({
          rs_2004_world_knowledge: { status: "not_in_game" },
        }),
      };
    }

    const { worldX: x, worldZ: z } = state.player;
    const trainable = state.skills
      .map((skill) => {
        const recommendation = trainingRecommendation(skill.name, skill.level);
        return recommendation
          ? {
              skill: skill.name,
              level: skill.level,
              method: recommendation.method,
              location: recommendation.location,
            }
          : null;
      })
      .filter(Boolean);

    const warnings: string[] = [];
    if (x >= 3210 && x <= 3240 && z >= 3360 && z <= 3390) {
      warnings.push("Dark wizards nearby; low-level players should leave.");
    }
    if (z >= 3520) {
      warnings.push("Wilderness nearby; other players may attack.");
    }
    if (
      x >= 3258 &&
      x <= 3270 &&
      z >= 3225 &&
      z <= 3235 &&
      state.player.combatLevel < 10
    ) {
      warnings.push("Al Kharid toll gate costs 10gp for low-level players.");
    }
    if (
      state.player.inCombat &&
      !state.inventory.some((item) =>
        FOOD_ITEMS.some((food) => item.name.toLowerCase().includes(food)),
      )
    ) {
      warnings.push("In combat with no visible food; walk away immediately.");
    }

    return {
      text: encodeToonValue({
        rs_2004_world_knowledge: {
          status: "ready",
          nearestBank: nearestBank(x, z),
          training: trainable,
          warnings,
        },
      }),
    };
  },
};

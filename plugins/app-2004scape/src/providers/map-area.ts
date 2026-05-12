import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { getRs2004scapeStateService } from "./service-access.js";

interface KnownArea {
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  features: string[];
  npcs: string[];
  adjacentAreas: string[];
  travelCoords: Array<{ name: string; x: number; z: number }>;
}

const KNOWN_AREAS: KnownArea[] = [
  {
    name: "Lumbridge",
    minX: 3180,
    maxX: 3265,
    minZ: 3180,
    maxZ: 3305,
    features: ["castle", "bank", "church", "kitchen", "starter fields"],
    npcs: ["chicken", "cow", "goblin"],
    adjacentAreas: ["Draynor", "Al Kharid", "Varrock road"],
    travelCoords: [
      { name: "lumbridge_spawn", x: 3222, z: 3218 },
      { name: "lumbridge_bank", x: 3208, z: 3220 },
      { name: "chickens", x: 3237, z: 3295 },
      { name: "cows", x: 3253, z: 3270 },
    ],
  },
  {
    name: "Varrock",
    minX: 3180,
    maxX: 3285,
    minZ: 3360,
    maxZ: 3465,
    features: ["banks", "square", "shops", "east mine"],
    npcs: ["guard", "shopkeeper", "dark wizard"],
    adjacentAreas: ["Barbarian Village", "Lumbridge road", "Wilderness"],
    travelCoords: [
      { name: "varrock_square", x: 3213, z: 3428 },
      { name: "varrock_bank", x: 3253, z: 3420 },
      { name: "mining_site", x: 3285, z: 3365 },
    ],
  },
  {
    name: "Draynor",
    minX: 3060,
    maxX: 3135,
    minZ: 3210,
    maxZ: 3275,
    features: ["bank", "willows", "fishing coast"],
    npcs: ["banker", "market guard"],
    adjacentAreas: ["Lumbridge", "Port Sarim", "Falador"],
    travelCoords: [
      { name: "draynor_bank", x: 3093, z: 3243 },
      { name: "draynor_willows", x: 3087, z: 3235 },
    ],
  },
  {
    name: "Falador",
    minX: 2920,
    maxX: 3025,
    minZ: 3310,
    maxZ: 3395,
    features: ["bank", "park", "anvils", "mining guild approach"],
    npcs: ["guard", "banker"],
    adjacentAreas: ["Draynor", "Barbarian Village", "Taverley"],
    travelCoords: [{ name: "falador_bank", x: 2946, z: 3368 }],
  },
];

const MAX_AREA_FEATURES = 8;
const MAX_AREA_NPCS = 8;
const MAX_ADJACENT_AREAS = 6;
const MAX_TRAVEL_COORDS = 6;

function identifyArea(x: number, z: number): KnownArea | null {
  return (
    KNOWN_AREAS.find(
      (area) =>
        x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ,
    ) ?? null
  );
}

export const mapAreaProvider: Provider = {
  name: "RS_SDK_MAP_AREA",
  description:
    "JSON current 2004scape map area with features, NPCs, and travel destinations.",
  descriptionCompressed: "JSON current area, features, NPCs, destinations.",
  contexts: ["game", "automation", "world", "state"],
  contextGate: { anyOf: ["game", "automation", "world", "state"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    try {
      const service = getRs2004scapeStateService(runtime);
      const state = service?.getBotState?.();
      if (!state?.connected || !state.inGame || !state.player) {
        return {
          text: JSON.stringify(
            {
              rs_2004_map_area: { status: "not_in_game" },
            },
            null,
            2,
          ),
        };
      }

      const { worldX: x, worldZ: z } = state.player;
      const area = identifyArea(x, z);

      return {
        text: JSON.stringify(
          {
            rs_2004_map_area: area
              ? {
                  status: "known",
                  name: area.name,
                  position: { x, z },
                  features: area.features.slice(0, MAX_AREA_FEATURES),
                  notableNpcs: area.npcs.slice(0, MAX_AREA_NPCS),
                  adjacentAreas: area.adjacentAreas.slice(
                    0,
                    MAX_ADJACENT_AREAS,
                  ),
                  travelCoords: area.travelCoords
                    .slice(0, MAX_TRAVEL_COORDS)
                    .map((coord) => ({
                      ...coord,
                      distance: Math.max(
                        Math.abs(coord.x - x),
                        Math.abs(coord.z - z),
                      ),
                    })),
                }
              : {
                  status: "unknown",
                  position: { x, z },
                  instruction: "Explore cautiously and update nearby context.",
                },
          },
          null,
          2,
        ),
      };
    } catch (error) {
      return {
        text: JSON.stringify(
          {
            rs_2004_map_area: {
              status: "error",
              reason: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2,
        ),
      };
    }
  },
};

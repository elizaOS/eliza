/**
 * nearby provider — spatial context for the LLM. Everything within the
 * server-side perception radius: other players, hostile/friendly NPCs,
 * notable scenery objects, ground items.
 *
 * PR 4 ships this provider with empty-list handling (the server's
 * `BotSdkPerceptionBuilder` will populate the nearby arrays in PR 5 /
 * PR 6 once we wire spatial queries against the NPC + ground-item
 * managers). The provider contract is frozen now so PR 5 is a pure
 * server-side data-source change.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import type { ScapeGameService } from "../services/game-service.js";
const NPC_LIMIT = 20;
const PLAYER_LIMIT = 12;
const ITEM_LIMIT = 20;
const OBJECT_LIMIT = 20;

export const nearbyProvider: Provider = {
  name: "SCAPE_NEARBY",
  description:
    "NPCs, players, ground items, and scenery objects within perception radius.",
  descriptionCompressed: "NPCs, players, items, scenery in range.",
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
      ) as unknown as ScapeGameService | null;
      if (!service) return { text: "" };
      const snapshot = service.getPerception();
      if (!snapshot) return { text: "" };

      return {
        text: JSON.stringify({
          scape_nearby: {
            npcs: snapshot.nearbyNpcs.slice(0, NPC_LIMIT).map((n) => ({
            id: n.id,
            name: n.name,
            x: n.x,
            z: n.z,
            hp: n.hp ?? null,
            cl: n.combatLevel ?? null,
          })),
            players: snapshot.nearbyPlayers.slice(0, PLAYER_LIMIT).map((p) => ({
            id: p.id,
            name: p.name,
            x: p.x,
            z: p.z,
            cl: p.combatLevel,
          })),
            groundItems: snapshot.nearbyGroundItems.slice(0, ITEM_LIMIT).map((g) => ({
            itemId: g.itemId,
            name: g.name,
            x: g.x,
            z: g.z,
            count: g.count,
          })),
            objects: snapshot.nearbyObjects.slice(0, OBJECT_LIMIT).map((o) => ({
            locId: o.locId,
            name: o.name,
            x: o.x,
            z: o.z,
          })),
          },
        }),
      };
    } catch (error) {
      return {
        text: JSON.stringify({
          scape_nearby: {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          },
        }),
      };
    }
  },
};

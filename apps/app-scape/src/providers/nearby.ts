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
import { encode } from "@toon-format/toon";

import type { ScapeGameService } from "../services/game-service.js";

export const nearbyProvider: Provider = {
  name: "SCAPE_NEARBY",
  description:
    "NPCs, players, ground items, and scenery objects within perception radius.",
  descriptionCompressed: "NPCs, players, items, scenery in range.",
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

    const parts: string[] = ["# NEARBY"];

    if (snapshot.nearbyNpcs.length > 0) {
      parts.push(
        `## NPCs\n${encode({
          npcs: snapshot.nearbyNpcs.map((n) => ({
            id: n.id,
            name: n.name,
            x: n.x,
            z: n.z,
            hp: n.hp ?? null,
            cl: n.combatLevel ?? null,
          })),
        })}`,
      );
    } else {
      parts.push("## NPCs\n(none in range)");
    }

    if (snapshot.nearbyPlayers.length > 0) {
      parts.push(
        `## PLAYERS\n${encode({
          players: snapshot.nearbyPlayers.map((p) => ({
            id: p.id,
            name: p.name,
            x: p.x,
            z: p.z,
            cl: p.combatLevel,
          })),
        })}`,
      );
    } else {
      parts.push("## PLAYERS\n(none in range)");
    }

    if (snapshot.nearbyGroundItems.length > 0) {
      parts.push(
        `## GROUND_ITEMS\n${encode({
          items: snapshot.nearbyGroundItems.map((g) => ({
            itemId: g.itemId,
            name: g.name,
            x: g.x,
            z: g.z,
            count: g.count,
          })),
        })}`,
      );
    } else {
      parts.push("## GROUND_ITEMS\n(none)");
    }

    if (snapshot.nearbyObjects.length > 0) {
      parts.push(
        `## OBJECTS\n${encode({
          objects: snapshot.nearbyObjects.map((o) => ({
            locId: o.locId,
            name: o.name,
            x: o.x,
            z: o.z,
          })),
        })}`,
      );
    } else {
      parts.push("## OBJECTS\n(none)");
    }

    return { text: parts.join("\n\n") };
  },
};

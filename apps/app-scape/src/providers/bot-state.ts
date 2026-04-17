/**
 * bot-state provider — the agent's own vitals, position, and combat
 * status, formatted as TOON for the autonomous loop prompt.
 *
 * Output is intentionally small and flat so the LLM always sees the
 * same field names. Empty string when no perception has arrived yet.
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

export const botStateProvider: Provider = {
  name: "SCAPE_BOT_STATE",
  description: "Current 'scape agent vitals, position, and combat state.",
  descriptionCompressed: "Agent vitals, position, combat state.",
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
    if (!snapshot) {
      return {
        text: "# SELF\n(no perception yet — agent has not received a snapshot)",
      };
    }
    const self = snapshot.self;
    const toon = encode({
      self: {
        name: self.name,
        combatLevel: self.combatLevel,
        hp: self.hp,
        maxHp: self.maxHp,
        x: self.x,
        z: self.z,
        level: self.level,
        runEnergy: self.runEnergy,
        inCombat: self.inCombat,
      },
    });
    return { text: `# SELF (tick ${snapshot.tick})\n${toon}` };
  },
};

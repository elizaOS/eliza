/**
 * journal provider — recent memories in TOON form.
 *
 * The LLM sees the 8 newest memories prefixed with their kind and
 * weight, so it can weigh novelty ("I just levelled up!") against
 * routine observations. Earlier memories are dropped by the journal
 * store's prune policy, not by this provider.
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

const RECENT_MEMORY_COUNT = 8;

export const journalProvider: Provider = {
  name: "SCAPE_JOURNAL",
  description:
    "Recent Scape Journal memories — observations, combat events, level-ups, and decisions from the last few steps or sessions.",
  descriptionCompressed: "Recent journal: observations, combat, level-ups, decisions.",
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
    if (!service) return { text: "" };
    const journal = service.getJournalService?.();
    if (!journal) return { text: "" };

    const memories = journal.getMemories(RECENT_MEMORY_COUNT);
    if (memories.length === 0) {
      return {
        text: "# JOURNAL\n(no memories yet — this is your first step)",
      };
    }

    const toon = encode({
      memories: memories.map((m) => ({
        kind: m.kind,
        text: m.text,
        weight: m.weight ?? 1,
      })),
    });
    return { text: `# JOURNAL (recent ${memories.length})\n${toon}` };
  },
};

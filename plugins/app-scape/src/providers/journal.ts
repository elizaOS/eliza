/**
 * journal provider — recent memories in JSON form.
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

import type { ScapeGameService } from "../services/game-service.js";

const RECENT_MEMORY_COUNT = 8;
const JOURNAL_TEXT_LIMIT = 180;

export const journalProvider: Provider = {
  name: "SCAPE_JOURNAL",
  description:
    "Recent Scape Journal memories — observations, combat events, level-ups, and decisions from the last few steps or sessions.",
  descriptionCompressed:
    "Recent journal: observations, combat, level-ups, decisions.",
  contexts: ["game", "automation", "world", "state", "memory", "tasks"],
  contextGate: {
    anyOf: ["game", "automation", "world", "state", "memory", "tasks"],
  },
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
      const journal = service.getJournalService?.();
      if (!journal) return { text: "" };

      const memories = journal.getMemories(RECENT_MEMORY_COUNT);
      if (memories.length === 0) {
        return {
          text: JSON.stringify({
            scape_journal: {
              status: "empty",
              memories: [],
            },
          }),
        };
      }

      const context = JSON.stringify({
        scape_journal: {
          status: "ready",
          memories: memories.map((m) => ({
            kind: m.kind,
            text: m.text.slice(0, JOURNAL_TEXT_LIMIT),
            weight: m.weight ?? 1,
          })),
        },
      });
      return { text: context };
    } catch {
      return { text: "" };
    }
  },
};

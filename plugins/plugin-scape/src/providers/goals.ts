/**
 * goals provider — the agent's active goal (if any) plus a short
 * list of recent completed / abandoned goals.
 *
 * The LLM is instructed (in the prompt) to prioritize the active
 * goal above all else unless an operator command overrides it.
 * Showing the history of completed and abandoned goals lets the
 * LLM avoid repeating itself without re-deriving "what was I
 * doing" on every step.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import type { ScapeGameService } from "../services/game-service.js";

const RECENT_ARCHIVED = 5;
const NOTE_LIMIT = 160;

export const goalsProvider: Provider = {
  name: "SCAPE_GOALS",
  description:
    "Current active goal (if any) plus the most recent completed / abandoned goals from the Scape Journal.",
  descriptionCompressed: "Active + recent completed/abandoned goals.",
  contexts: ["game", "automation", "world", "state", "tasks"],
  contextGate: { anyOf: ["game", "automation", "world", "state", "tasks"] },
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
      ) as ScapeGameService | null;
      if (!service) return { text: "" };
      const journal = service.getJournalService?.();
      if (!journal) return { text: "" };

      const active = journal.getActiveGoal();
      const allGoals = journal.getGoals();
      const archived = allGoals
        .filter((g) => g.status === "completed" || g.status === "abandoned")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_ARCHIVED);

      return {
        text: JSON.stringify({
          scape_goals: {
            active: active
              ? {
                  id: active.id,
                  title: active.title,
                  source: active.source,
                  progress: active.progress ?? 0,
                  notes: (active.notes ?? "").slice(0, NOTE_LIMIT),
                }
              : null,
            recent: archived.map((g) => ({
              title: g.title,
              status: g.status,
              source: g.source,
            })),
          },
        }),
      };
    } catch (error) {
      return {
        text: JSON.stringify({
          scape_goals: {
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
          },
        }),
      };
    }
  },
};

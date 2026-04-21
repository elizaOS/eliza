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
import { encode } from "@toon-format/toon";

import type { ScapeGameService } from "../services/game-service.js";

const RECENT_ARCHIVED = 5;

export const goalsProvider: Provider = {
  name: "SCAPE_GOALS",
  description:
    "Current active goal (if any) plus the most recent completed / abandoned goals from the Scape Journal.",
  descriptionCompressed: "Active + recent completed/abandoned goals.",
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

    const active = journal.getActiveGoal();
    const allGoals = journal.getGoals();
    const archived = allGoals
      .filter((g) => g.status === "completed" || g.status === "abandoned")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_ARCHIVED);

    const parts: string[] = ["# GOALS"];

    if (active) {
      parts.push(
        `## ACTIVE\n${encode({
          id: active.id,
          title: active.title,
          source: active.source,
          progress: active.progress ?? 0,
          notes: active.notes ?? "",
        })}`,
      );
    } else {
      parts.push("## ACTIVE\n(no active goal — pick one!)");
    }

    if (archived.length > 0) {
      parts.push(
        `## RECENT\n${encode({
          recent: archived.map((g) => ({
            title: g.title,
            status: g.status,
            source: g.source,
          })),
        })}`,
      );
    }

    return { text: parts.join("\n\n") };
  },
};

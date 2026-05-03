/**
 * COMPLETE_GOAL — mark a goal as completed or abandoned. The LLM
 * chooses this when it's satisfied the goal is done, or when it
 * decides the goal was a bad idea.
 *
 * LLM response shape:
 *
 *   <action>COMPLETE_GOAL</action>
 *   <status>completed</status>  (or "abandoned")
 *   <notes>Hit level 20 at the cow field near Falador.</notes>
 *
 * `id` is optional — if omitted, the active goal is used.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ScapeGameService } from "../services/game-service.js";
import { hasActionTag, resolveActionText } from "../shared-state.js";
import { extractParam } from "./param-parser.js";

export const completeGoal: Action = {
  name: "COMPLETE_GOAL",
  description:
    "Mark the active goal (or a specific goal id) as completed or abandoned. Use <status>completed|abandoned</status> and optional <notes>why</notes>.",
  descriptionCompressed: "Mark goal completed or abandoned.",
  similes: ["FINISH_GOAL", "ABANDON_GOAL", "CLOSE_GOAL"],
  examples: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionTag(message, "COMPLETE_GOAL");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
    const journal = service?.getJournalService?.();
    if (!journal) {
      const err = "Scape journal not available.";
      callback?.({ text: err, action: "COMPLETE_GOAL" });
      return { success: false, text: err };
    }

    const text = resolveActionText(message);
    const explicitId = extractParam(text, "id");
    const statusRaw = (
      extractParam(text, "status") ?? "completed"
    ).toLowerCase();
    if (statusRaw !== "completed" && statusRaw !== "abandoned") {
      const err = "status must be 'completed' or 'abandoned'.";
      callback?.({ text: err, action: "COMPLETE_GOAL" });
      return { success: false, text: err };
    }
    const notes = extractParam(text, "notes") ?? undefined;

    const goalId = explicitId ?? journal.getActiveGoal()?.id;
    if (!goalId) {
      const err = "no goal to close.";
      callback?.({ text: err, action: "COMPLETE_GOAL" });
      return { success: false, text: err };
    }

    const updated = journal.markGoalStatus(
      goalId,
      statusRaw as "completed" | "abandoned",
      notes,
    );
    if (!updated) {
      const err = `goal id=${goalId} not found.`;
      callback?.({ text: err, action: "COMPLETE_GOAL" });
      return { success: false, text: err };
    }

    const msg = `goal "${updated.title}" → ${statusRaw}`;
    callback?.({ text: msg, action: "COMPLETE_GOAL" });
    return { success: true, text: msg };
  },
};

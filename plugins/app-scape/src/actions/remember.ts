/**
 * REMEMBER — the agent writes a free-form note to the Scape Journal.
 * Use for things that should survive the sliding event-log window:
 * observations, lessons learned, reminders to self, important
 * landmarks.
 *
 * LLM response shape:
 *
 *   <action>REMEMBER</action>
 *   <kind>lesson</kind>
 *   <text>Skeletons near Varrock don't drop coins — skip them next time.</text>
 *   <weight>3</weight>
 *
 * `kind` defaults to "note" if omitted.
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
import { extractParam, extractParamInt } from "./param-parser.js";

export const remember: Action = {
  name: "REMEMBER",
  description:
    "Write a note to the Scape Journal. Use for lessons, landmarks, and things you want to remember next step.",
  descriptionCompressed: "Write note to Scape Journal for future reference.",
  similes: ["NOTE", "LOG", "JOURNAL", "RECORD"],
  examples: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionTag(message, "REMEMBER");
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
      callback?.({ text: err, action: "REMEMBER" });
      return { success: false, text: err };
    }

    const llmText = resolveActionText(message);
    const text = extractParam(llmText, "text");
    if (!text) {
      const err = "REMEMBER requires <text>what to remember</text>.";
      callback?.({ text: err, action: "REMEMBER" });
      return { success: false, text: err };
    }
    const kind = extractParam(llmText, "kind") ?? "note";
    const weight = extractParamInt(llmText, "weight") ?? 2;

    const snapshot = service?.getPerception();
    journal.addMemory({
      kind,
      text: text.slice(0, 200),
      weight: Math.max(1, Math.min(5, weight)),
      x: snapshot?.self.x,
      z: snapshot?.self.z,
    });

    const msg = `journal: ${kind} recorded`;
    callback?.({ text: msg, action: "REMEMBER" });
    return { success: true, text: msg };
  },
};

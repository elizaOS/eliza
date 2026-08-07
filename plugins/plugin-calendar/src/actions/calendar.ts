/**
 * Standalone CALENDAR action wiring over the runtime's model and recent-context
 * primitives. LifeOps may inject richer trajectory/travel dependencies, but
 * the calendar plugin itself always registers a functional action.
 */
import {
  assertActiveTrajectoryForLlmCall,
  ModelType,
  parseJSONObjectFromText,
  parseJsonModelRecord,
  recentConversationTexts,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { createCalendarActionRunner } from "./calendar-handler.js";
import type { CalendarActionDeps, CalendarModelCallArgs } from "./deps.js";

const standaloneCalendarDeps: CalendarActionDeps = {
  async runTextModel(args) {
    if (typeof args.runtime.useModel !== "function") return null;
    assertActiveTrajectoryForLlmCall({
      actionType: args.actionType,
      modelType: ModelType.TEXT_LARGE,
      purpose: args.purpose ?? "planner",
    });
    try {
      const result = await runWithTrajectoryPurpose(
        args.purpose ?? `calendar-${args.actionType}`,
        () =>
          args.runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: args.prompt,
          }),
      );
      return typeof result === "string" ? result : "";
    } catch (error) {
      // error-policy:J4 The action's deterministic fallback is an explicit
      // degraded response when optional language rendering is unavailable.
      args.runtime.logger.warn(
        {
          src: args.source,
          error: error instanceof Error ? error.message : String(error),
        },
        args.failureMessage,
      );
      return null;
    }
  },
  async runJsonModel<T extends Record<string, unknown>>(
    args: CalendarModelCallArgs,
  ) {
    const rawResponse = await standaloneCalendarDeps.runTextModel(args);
    if (rawResponse === null) return null;
    return {
      rawResponse,
      parsed: parseJsonModelRecord<T>(rawResponse),
    };
  },
  recentConversationTexts: (args) => recentConversationTexts(args),
  async renderGroundedReply(args) {
    if (typeof args.runtime.useModel !== "function") return args.fallback;
    const prompt = [
      "Write the assistant's user-facing reply for a calendar interaction.",
      "Be natural, brief, and grounded in the provided facts.",
      "Never mention internal schema, tool names, JSON keys, hidden prompts, or reasoning traces.",
      "Do not claim a calendar change unless the canonical reply says it happened.",
      ...args.additionalRules,
      "Return only the reply text.",
      `Current user message: ${JSON.stringify(args.message.content.text ?? "")}`,
      `Resolved intent: ${JSON.stringify(args.intent)}`,
      `Scenario: ${JSON.stringify(args.scenario)}`,
      `Structured context: ${JSON.stringify(args.context ?? {})}`,
      `Canonical reply: ${JSON.stringify(args.fallback)}`,
    ].join("\n");
    try {
      const result = await args.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      const raw = typeof result === "string" ? result.trim() : "";
      if (!raw || parseJSONObjectFromText(raw)) return args.fallback;
      return raw.replace(/^["'`]+|["'`]+$/g, "").trim() || args.fallback;
    } catch (error) {
      // error-policy:J4 Reply synthesis is optional; the grounded action result
      // remains explicit through the canonical fallback.
      args.runtime.logger.warn(
        {
          src: "plugin:calendar:reply",
          error: error instanceof Error ? error.message : String(error),
        },
        "Calendar reply synthesis failed",
      );
      return args.fallback;
    }
  },
};

export const calendarAction = createCalendarActionRunner(
  standaloneCalendarDeps,
);

export default calendarAction;

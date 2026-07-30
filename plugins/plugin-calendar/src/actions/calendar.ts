/**
 * Standalone CALENDAR action wiring over the runtime's model and recent-context
 * primitives. LifeOps may inject richer trajectory/travel dependencies, but
 * the calendar plugin itself always registers a functional action.
 */
import {
  assertActiveTrajectoryForLlmCall,
  ModelType,
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
};

export const calendarAction = createCalendarActionRunner(
  standaloneCalendarDeps,
);

export default calendarAction;

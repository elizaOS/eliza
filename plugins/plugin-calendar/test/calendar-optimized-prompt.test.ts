/**
 * Tests that the calendar plan extractor applies the DSPy-optimized prompt when
 * one is loaded, driving `extractCalendarPlanWithLlm` against a mocked runtime
 * model (deterministic, no live LLM).
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "../src/actions/calendar-handler.js";
import type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
} from "../src/actions/deps.js";

function runtimeWithOptimizedPrompt(prompt: string | null): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              task === "calendar_extract" && prompt
                ? { prompt, optimizerSource: "gepa" }
                : null,
          }
        : null,
  } as unknown as IAgentRuntime;
}

function userMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    content: { text },
  } as unknown as Memory;
}

describe("calendar plan extractor — OptimizedPromptService routing", () => {
  afterEach(() => vi.useRealTimers());

  it.each([null, "OPTIMIZED CALENDAR: classify the calendar action tersely."])(
    "preserves request and local-date context with extractor instructions %j",
    async (instructions) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-05T02:41:04.618Z"));
      let capturedPrompt = "";
      const deps: CalendarActionDeps = {
        runTextModel: vi.fn(async () => null),
        runJsonModel: vi.fn(
          async <T extends Record<string, unknown>>(
            args: CalendarModelCallArgs,
          ): Promise<CalendarJsonModelResult<T>> => {
            capturedPrompt = args.prompt;
            return {
              rawResponse: JSON.stringify({
                subaction: null,
                shouldAct: false,
                response: "Which calendar action should I take?",
                queries: [],
              }),
              parsed: {
                subaction: null,
                shouldAct: false,
                response: "Which calendar action should I take?",
                queries: [],
              } as T,
            };
          },
        ),
        recentConversationTexts: vi.fn(async () => []),
      };
      createCalendarActionRunner(deps);

      await extractCalendarPlanWithLlm(
        runtimeWithOptimizedPrompt(instructions),
        userMessage("Move lunch with Sam to tomorrow at noon"),
        undefined,
        "Move lunch with Sam to tomorrow at noon",
        "America/Los_Angeles",
      );

      if (instructions) {
        expect(capturedPrompt).toContain(instructions);
        expect(capturedPrompt).not.toContain("Plan the calendar action");
      }
      expect(capturedPrompt).toContain(
        "yesterday = 2026-08-03, today = 2026-08-04, tomorrow = 2026-08-05",
      );
      expect(capturedPrompt).toContain("Current timezone: America/Los_Angeles");
      expect(capturedPrompt).toContain(
        "Move lunch with Sam to tomorrow at noon",
      );
    },
  );
});

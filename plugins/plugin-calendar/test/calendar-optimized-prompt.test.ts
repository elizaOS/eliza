/**
 * Tests that the calendar plan extractor applies the DSPy-optimized prompt when
 * one is loaded, driving `extractCalendarPlanWithLlm` against a mocked runtime
 * model (deterministic, no live LLM).
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "../src/actions/calendar-handler.js";
import type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
} from "../src/actions/deps.js";

function runtimeWithOptimizedPrompt(prompt: string): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              task === "calendar_extract"
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
  it("swaps calendar_extract instructions while preserving request context", async () => {
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
      runtimeWithOptimizedPrompt(
        "OPTIMIZED CALENDAR: classify the calendar action tersely.",
      ),
      userMessage("Move lunch with Sam to tomorrow at noon"),
      undefined,
      "Move lunch with Sam to tomorrow at noon",
      "America/New_York",
    );

    expect(capturedPrompt).toContain(
      "OPTIMIZED CALENDAR: classify the calendar action tersely.",
    );
    expect(capturedPrompt).not.toContain("Plan the calendar action");
    expect(capturedPrompt).toContain("Current timezone: America/New_York");
    expect(capturedPrompt).toContain("Move lunch with Sam to tomorrow at noon");
  });
});

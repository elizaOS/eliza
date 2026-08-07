/**
 * Tests for the calendar action runner factory. `createCalendarActionRunner`
 * wires the host-injected deps and returns the `CALENDAR` action; these assert
 * the action surface (name, key similes, capability tags) and that the factory
 * returns a usable Action object.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "../src/index.js";

function fakeDeps(): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
  };
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    content: { text },
  } as unknown as Memory;
}

function runtimeWithOptimizedPrompt(promptByTask: Record<string, string>) {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              promptByTask[task]
                ? { prompt: promptByTask[task], optimizerSource: "gepa" }
                : null,
          }
        : null,
  } as unknown as IAgentRuntime;
}

describe("createCalendarActionRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the CALENDAR action wired with the injected deps", () => {
    const action = createCalendarActionRunner(fakeDeps());
    expect(action.name).toBe("CALENDAR");
    expect(typeof action.handler).toBe("function");
    expect(typeof action.validate).toBe("function");
  });

  it("advertises the calendar read/write/create similes", () => {
    const action = createCalendarActionRunner(fakeDeps());
    for (const simile of [
      "CALENDAR_FEED",
      "CALENDAR_CREATE_EVENT",
      "CALENDAR_NEXT_EVENT",
      "CALENDAR_SEARCH_EVENTS",
    ]) {
      expect(action.similes).toContain(simile);
    }
  });

  it("tags the action as the calendar domain with CRUD capabilities", () => {
    const action = createCalendarActionRunner(fakeDeps());
    expect(action.tags).toContain("domain:calendar");
    expect(action.tags).toContain("capability:write");
    expect(action.tags).toContain("capability:delete");
  });

  it("is callable without a travel-buffer dep (travel is optional)", () => {
    const deps = fakeDeps();
    expect(deps.travelBuffer).toBeUndefined();
    const action = createCalendarActionRunner(deps);
    expect(action.name).toBe("CALENDAR");
  });

  it("routes calendar_extract planner instructions through OptimizedPromptService", async () => {
    let capturedPrompt = "";
    const deps: CalendarActionDeps = {
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async (args) => {
        capturedPrompt = args.prompt;
        return {
          rawResponse:
            '{"subaction":null,"shouldAct":false,"response":"clarify","queries":[]}',
          parsed: {
            subaction: null,
            shouldAct: false,
            response: "clarify",
            queries: [],
          },
        };
      }),
      recentConversationTexts: vi.fn(async () => []),
    };
    createCalendarActionRunner(deps);

    await extractCalendarPlanWithLlm(
      runtimeWithOptimizedPrompt({
        calendar_extract: "OPTIMIZED CALENDAR EXTRACTION INSTRUCTIONS",
      }),
      message("Schedule lunch with Maya tomorrow at noon."),
      undefined,
      "calendar",
      "America/New_York",
    );

    expect(capturedPrompt).toContain(
      "OPTIMIZED CALENDAR EXTRACTION INSTRUCTIONS",
    );
    expect(capturedPrompt).not.toContain(
      "Plan the calendar action for this request.",
    );
    expect(capturedPrompt).toContain("Current timezone: America/New_York");
    expect(capturedPrompt).toContain(
      "Current request:\nSchedule lunch with Maya tomorrow at noon.",
    );
  });

  it("anchors tomorrow to the user's local date across the UTC day boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T02:41:04.618Z"));
    let capturedPrompt = "";
    const deps: CalendarActionDeps = {
      runTextModel: vi.fn(async () => null),
      runJsonModel: vi.fn(async (args) => {
        capturedPrompt = args.prompt;
        return {
          rawResponse:
            '{"subaction":"create_event","shouldAct":true,"response":"","queries":[]}',
          parsed: {
            subaction: "create_event",
            shouldAct: true,
            response: "",
            queries: [],
          },
        };
      }),
      recentConversationTexts: vi.fn(async () => []),
    };
    createCalendarActionRunner(deps);

    await extractCalendarPlanWithLlm(
      runtimeWithOptimizedPrompt({}),
      message("Add demo tomorrow at 9am."),
      undefined,
      "calendar",
      "America/Los_Angeles",
    );

    expect(capturedPrompt).toContain("Current timezone: America/Los_Angeles");
    expect(capturedPrompt).toContain(
      "yesterday = 2026-08-03, today = 2026-08-04, tomorrow = 2026-08-05",
    );
    expect(capturedPrompt).not.toContain("tomorrow = 2026-08-06");
  });
});

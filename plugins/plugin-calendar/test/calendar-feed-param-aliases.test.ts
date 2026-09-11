/**
 * Pins the CALENDAR action's tolerance for planner-invented calendar-id args.
 * Live failure (tj-e5efcae0693244): a feed read carried top-level calendar_id
 * AND calendarId, validateToolArgs rejected both as undeclared, and the whole
 * read failed. The schema now declares an advisory calendarId parameter whose
 * aliases claim the natural variants; the handler never reads it. Deterministic
 * unit suite over the exported runner — no runtime, no network.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

function deps(): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
    mutationGateway: {
      schedule: vi.fn(),
      modify: vi.fn(),
      cancel: vi.fn(),
    },
  } as unknown as CalendarActionDeps;
}

describe("CALENDAR feed param aliases", () => {
  it("declares an advisory calendarId param claiming the live natural variants", () => {
    const action = createCalendarActionRunner(deps());
    const param = (action.parameters ?? []).find(
      (candidate) => candidate.name === "calendarId",
    );
    expect(param).toBeDefined();
    expect(param?.required).toBe(false);
    // The exact keys the live planner invented on one call.
    expect(param?.aliases).toEqual(
      expect.arrayContaining(["calendar_id", "calendarid"]),
    );
  });

  it("keeps every previously declared parameter intact", () => {
    const action = createCalendarActionRunner(deps());
    const names = (action.parameters ?? []).map((p) => p.name);
    for (const expected of [
      "subaction",
      "intent",
      "title",
      "query",
      "queries",
      "details",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

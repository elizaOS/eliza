/**
 * Tests for the calendar action runner factory. `createCalendarActionRunner`
 * wires the host-injected deps and returns the `CALENDAR` action; these assert
 * the action surface (name, key similes, capability tags) and that the factory
 * returns a usable Action object.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type CalendarActionDeps,
  createCalendarActionRunner,
} from "../src/index.js";

function fakeDeps(): CalendarActionDeps {
  return {
    runTextModel: vi.fn(async () => null),
    runJsonModel: vi.fn(async () => null),
    recentConversationTexts: vi.fn(async () => []),
  };
}

describe("createCalendarActionRunner", () => {
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
});

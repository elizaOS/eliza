/**
 * Root-entry registration test proving package import constructs every action
 * and leaves the canonical calendar-source authorization closure callable.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CalendarView,
  calendarPlugin,
  calendarSourcesAction,
  SimpleCalendarView,
} from "./index.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000901";

describe("@elizaos/plugin-calendar root registration", () => {
  it("exports one canonical shipped Calendar implementation", () => {
    expect(CalendarView).toBe(SimpleCalendarView);
  });

  it("registers one callable canonical CALENDAR_SOURCES action", async () => {
    const registered = calendarPlugin.actions?.filter(
      (action) => action.name === "CALENDAR_SOURCES",
    );
    expect(registered).toEqual([calendarSourcesAction]);
    expect(typeof calendarSourcesAction.validate).toBe("function");
    expect(typeof calendarSourcesAction.handler).toBe("function");
    const validate = calendarSourcesAction.validate;
    if (!validate) throw new Error("CALENDAR_SOURCES validate is missing.");

    const runtime = { agentId: AGENT_ID } as IAgentRuntime;
    const message = {
      id: "00000000-0000-0000-0000-000000000902",
      entityId: AGENT_ID,
      roomId: "00000000-0000-0000-0000-000000000903",
      content: { text: "List my calendar sources.", source: "test" },
    } as Memory;
    expect(await validate(runtime, message)).toBe(true);
  });
});

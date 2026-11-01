/**
 * Root-entry registration test proving package import constructs every action
 * and leaves the canonical calendar-source authorization closure callable.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { normalizeActionName } from "@elizaos/plugin-assistant";
import { describe, expect, it } from "vitest";
import {
  CalendarPage,
  CalendarView,
  calendarPlugin,
  calendarSourcesAction,
} from "./index.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000901";

describe("@elizaos/plugin-calendar root registration", () => {
  it("exports one canonical shipped Calendar implementation", () => {
    expect(CalendarView).toBe(CalendarPage);
  });

  it("declares owner-gated server capabilities through server interaction", () => {
    const view = calendarPlugin.views?.find(({ id }) => id === "calendar");
    expect(view?.roleGate).toEqual({ minRole: "OWNER" });
    expect(typeof view?.serverInteract).toBe("function");
    expect(view?.capabilities?.map(({ id }) => id)).toEqual([
      "get-events",
      "create-event",
    ]);
    const createEvent = view?.capabilities?.find(
      ({ id }) => id === "create-event",
    );
    expect(createEvent?.params?.title).toMatchObject({
      type: "string",
      required: true,
    });
    expect(createEvent?.params?.startAt).toMatchObject({
      type: "string",
      required: true,
    });
    expect(createEvent?.description).toMatch(/built-in/i);
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

  // Retrieval drops a simile that two catalog entries claim (live: CALENDAR
  // on every promoted child once the umbrella was not in the catalog).
  it("gives every simile exactly one owning action", () => {
    const actions = calendarPlugin.actions ?? [];
    const owners = new Map<string, string[]>();
    for (const action of actions)
      for (const simile of new Set(action.similes?.map(normalizeActionName)))
        owners.set(simile, [...(owners.get(simile) ?? []), action.name]);
    expect([...owners].filter(([, names]) => names.length > 1)).toEqual([]);
    const similesOf = (name: string) =>
      actions.find((action) => action.name === name)?.similes;
    expect(similesOf("CALENDAR_CREATE_EVENT")).toEqual(["CREATE_EVENT"]);
    expect(similesOf("CALENDAR_DELETE_EVENT")).toEqual(["DELETE_EVENT"]);
  });
});

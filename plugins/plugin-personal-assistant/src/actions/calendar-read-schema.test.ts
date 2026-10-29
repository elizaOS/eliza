import { actionToTool } from "@elizaos/core";
import { expect, it } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.ts";
import { personalAssistantPlugin } from "../plugin.ts";

const registered = personalAssistantPlugin.actions ?? [];

const local = { timeZone: "America/Los_Angeles" };
for (const name of ["CALENDAR_FEED", "CALENDAR_SEARCH_EVENTS"] as const) {
  const matches = registered.filter((action) => action.name === name);
  const action = matches[0];
  if (!action) throw new Error(`Missing registered ${name}`);
  it(`${name} registers one owner-only action with exclusive model-tool read windows`, () => {
    expect(matches).toHaveLength(1);
    expect(action.roleGate).toEqual({ minRole: "OWNER" });
    const schema = actionToTool(action).function.parameters;
    expect(schema.properties?.details?.oneOf?.length).toBeGreaterThanOrEqual(4);
  });
  it(`${name} rejects the actual mixed-date availability payload before handler execution`, () => {
    const args = {
      intent: "Am I free tomorrow at 3:05pm?",
      ...(name === "CALENDAR_SEARCH_EVENTS" ? { query: "Sam" } : {}),
      details: {
        date: "2026-10-28",
        timeMin: "2026-10-28T15:00:00",
        timeMax: "2026-10-28T15:15:00",
        ...local,
      },
    };
    expect(validateToolArgs(action, args).valid).toBe(false);
  });
  const lowerBounds = ["timeMin", "timemin", "time_min"];
  const upperBounds = ["timeMax", "timemax", "time_max"];
  const argsFor = (details: Record<string, unknown>) => ({
    intent: "Read the specified calendar window without changing it.",
    ...(name === "CALENDAR_SEARCH_EVENTS" ? { query: "Sam" } : {}),
    details,
  });
  it("accepts all historical bound spellings through registered tool validation", () => {
    for (const min of lowerBounds)
      for (const max of upperBounds) {
        expect(
          validateToolArgs(
            action,
            argsFor({
              [min]: "2026-10-28T15:00:00",
              [max]: "2026-10-28T15:15:00",
              time_zone: "America/Los_Angeles",
              force_sync: false,
            }),
          ).valid,
        ).toBe(true);
      }
    for (const key of ["windowDays", "windowdays", "window_days"]) {
      expect(
        validateToolArgs(action, argsFor({ [key]: 2, timezone: "UTC" })).valid,
      ).toBe(true);
    }
  });
  it("rejects mixed and incomplete windows with every historical bound spelling", () => {
    for (const min of lowerBounds)
      for (const max of upperBounds) {
        const bounds = {
          [min]: "2026-10-28T15:00:00",
          [max]: "2026-10-28T15:15:00",
        };
        for (const other of [{ date: "2026-10-28" }, { window_days: 2 }]) {
          expect(
            validateToolArgs(action, argsFor({ ...bounds, ...other })).valid,
          ).toBe(false);
        }
        expect(
          validateToolArgs(action, argsFor({ [min]: bounds[min] })).valid,
        ).toBe(false);
        expect(
          validateToolArgs(action, argsFor({ [max]: bounds[max] })).valid,
        ).toBe(false);
      }
    for (const extra of [
      { start_at: "2026-10-28T15:00:00" },
      { unexpected: true },
    ]) {
      expect(
        validateToolArgs(action, argsFor({ date: "2026-10-28", ...extra }))
          .valid,
      ).toBe(false);
    }
  });
  it.each([
    { date: "2026-10-28", ...local },
    { date: "2026-10-28", endDate: "2026-10-29", ...local },
    {
      timeMin: "2026-10-28T15:00:00",
      timeMax: "2026-10-28T15:15:00",
      ...local,
    },
    { windowDays: 2, ...local },
    {},
  ])(
    `${name} preserves each supported read-window representation: %j`,
    (details) => {
      expect(
        validateToolArgs(action, {
          intent:
            "Find a free30-minute spot tomorrow afternoon for a call with Sam.",
          ...(name === "CALENDAR_SEARCH_EVENTS" ? { query: "Sam" } : {}),
          details,
        }).valid,
      ).toBe(true);
    },
  );
}

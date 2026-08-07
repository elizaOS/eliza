/**
 * Smoke test asserting the calendar plugin registers its data service, the
 * migration service, deterministic conflict action, schema, and calendar view.
 */
import { describe, expect, it } from "vitest";
import {
  CalendarService,
  calendarAction,
  calendarPlugin,
  calendarSourcesAction,
  calendarSourcesProvider,
  conflictDetectAction,
} from "../src/index.js";
import { CalendarMigrationService } from "../src/service/migration.js";

describe("plugin-calendar surface", () => {
  it("registers data services, schema, and the calendar view", () => {
    expect(calendarPlugin.schema).toBeDefined();
    expect(calendarPlugin.services).toContain(CalendarService);
    expect(calendarPlugin.services).toContain(CalendarMigrationService);
    expect(calendarPlugin.views?.[0]?.id).toBe("calendar");
    expect(calendarPlugin.views?.[0]?.componentExport).toBe("CalendarView");
  });

  it("declares the calendar view as GUI-only", () => {
    expect(calendarPlugin.views?.[0]?.modalities).toEqual(["gui"]);
  });

  it("registers calendar event, source-administration, and conflict surfaces", () => {
    expect(calendarPlugin.actions).toEqual([
      calendarAction,
      calendarSourcesAction,
      conflictDetectAction,
    ]);
    expect(calendarPlugin.providers).toContain(calendarSourcesProvider);
    expect(calendarSourcesAction.subActions).toBeUndefined();
    expect(
      calendarSourcesAction.parameters?.find(
        (parameter) => parameter.name === "operation",
      )?.schema,
    ).toMatchObject({
      type: "string",
      enum: ["list", "select", "deselect", "connect", "reconnect"],
    });
    expect(calendarAction.description).not.toMatch(
      /scaffold_stub|not migrated|not yet implemented/i,
    );
    expect(calendarSourcesAction.description).not.toMatch(
      /scaffold_stub|not migrated|not yet implemented/i,
    );
    expect(conflictDetectAction.description).not.toMatch(
      /scaffold_stub|not migrated|not yet implemented/i,
    );
  });
});

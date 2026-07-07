/**
 * Smoke test asserting the calendar plugin registers its data service, the
 * migration service, the schema, and the calendar view.
 */
import { describe, expect, it } from "vitest";
import { CalendarService, calendarPlugin } from "../src/index.js";
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

  it("does not expose scaffold calendar actions directly", () => {
    expect(calendarPlugin.actions ?? []).toEqual([]);
  });
});

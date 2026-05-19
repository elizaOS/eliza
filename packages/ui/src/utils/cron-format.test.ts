import { describe, expect, it } from "vitest";
import { CRON_PRESETS, describeCron, formatSchedule } from "./cron-format";

describe("describeCron", () => {
  it("recognises every-N-minutes", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
  });

  it("recognises top-of-the-hour", () => {
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });

  it("recognises daily at a specific time", () => {
    expect(describeCron("0 9 * * *")).toBe("Every day at 9am");
    expect(describeCron("30 14 * * *")).toBe("Every day at 2:30pm");
    expect(describeCron("0 0 * * *")).toBe("Every day at 12am");
    expect(describeCron("0 12 * * *")).toBe("Every day at 12pm");
  });

  it("recognises weekday / weekend ranges", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Every weekday at 9am");
    expect(describeCron("0 10 * * 0,6")).toBe("Every weekend at 10am");
  });

  it("recognises a specific day of week", () => {
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 9am");
    expect(describeCron("0 18 * * 5")).toBe("Every Friday at 6pm");
  });

  it("returns null for unrecognised expressions", () => {
    expect(describeCron("0 9 1 * *")).toBeNull();
    expect(describeCron("nonsense")).toBeNull();
    expect(describeCron("")).toBeNull();
    expect(describeCron("0 9 * 1 *")).toBeNull();
  });

  it("rejects malformed numbers", () => {
    expect(describeCron("99 9 * * *")).toBeNull();
    expect(describeCron("0 25 * * *")).toBeNull();
  });

  it("matches every preset to a friendly description", () => {
    for (const preset of CRON_PRESETS) {
      expect(describeCron(preset.expression)).not.toBeNull();
    }
  });
});

describe("formatSchedule", () => {
  it("returns the friendly description when available", () => {
    expect(formatSchedule("0 9 * * 1-5")).toBe("Every weekday at 9am");
  });

  it("falls back to the raw expression when not recognised", () => {
    expect(formatSchedule("0 9 1 * *")).toBe("0 9 1 * *");
  });
});

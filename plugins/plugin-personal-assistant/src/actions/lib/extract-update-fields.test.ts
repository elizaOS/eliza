import { __setExtractorRaw } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { extractUpdateFieldsWithLlm } from "./extract-update-fields.js";

const BASE_ARGS = {
  intent: "change my workout",
  currentTitle: "Workout",
  currentCadenceKind: "weekly",
  currentWindows: ["morning"],
};

async function extract(record: unknown) {
  __setExtractorRaw(JSON.stringify(record));
  return extractUpdateFieldsWithLlm({
    runtime: {} as never,
    ...BASE_ARGS,
  });
}

beforeEach(() => {
  __setExtractorRaw("{}");
});

describe("extractUpdateFieldsWithLlm field validation", () => {
  it("returns all-null fields when the model output is unparseable", async () => {
    __setExtractorRaw("not json at all");
    const fields = await extractUpdateFieldsWithLlm({
      runtime: {} as never,
      ...BASE_ARGS,
    });
    expect(fields.title).toBeNull();
    expect(fields.dueDate).toBeNull();
    expect(fields.priority).toBeNull();
  });

  describe("dueDate calendar validity", () => {
    it("accepts a real calendar date", async () => {
      const fields = await extract({ dueDate: "2026-04-17" });
      expect(fields.dueDate).toBe("2026-04-17");
    });

    it("accepts a leap-year February 29", async () => {
      const fields = await extract({ dueDate: "2028-02-29" });
      expect(fields.dueDate).toBe("2028-02-29");
    });

    it("rejects February 29 in a non-leap year", async () => {
      // 2026 is not a leap year; the previous check (day <= 31) let this through.
      const fields = await extract({ dueDate: "2026-02-29" });
      expect(fields.dueDate).toBeNull();
    });

    it("rejects February 31", async () => {
      const fields = await extract({ dueDate: "2026-02-31" });
      expect(fields.dueDate).toBeNull();
    });

    it("rejects April 31", async () => {
      const fields = await extract({ dueDate: "2026-04-31" });
      expect(fields.dueDate).toBeNull();
    });

    it("rejects an out-of-range month", async () => {
      const fields = await extract({ dueDate: "2026-13-01" });
      expect(fields.dueDate).toBeNull();
    });

    it("rejects a malformed date string", async () => {
      const fields = await extract({ dueDate: "2026-4-1" });
      expect(fields.dueDate).toBeNull();
    });
  });

  describe("timeOfDay parsing", () => {
    it("normalizes 24h times", async () => {
      const fields = await extract({ timeOfDay: "6:30" });
      expect(fields.timeOfDay).toBe("06:30");
    });

    it("converts 12h times with meridiem", async () => {
      expect((await extract({ timeOfDay: "6:30am" })).timeOfDay).toBe("06:30");
      expect((await extract({ timeOfDay: "3:00 pm" })).timeOfDay).toBe("15:00");
      expect((await extract({ timeOfDay: "12pm" })).timeOfDay).toBe("12:00");
      expect((await extract({ timeOfDay: "12 am" })).timeOfDay).toBe("00:00");
    });

    it("rejects an out-of-range 12h hour", async () => {
      expect((await extract({ timeOfDay: "13pm" })).timeOfDay).toBeNull();
    });

    it("handles noon and midnight", async () => {
      expect((await extract({ timeOfDay: "noon" })).timeOfDay).toBe("12:00");
      expect((await extract({ timeOfDay: "midnight" })).timeOfDay).toBe(
        "00:00",
      );
    });

    it("rejects an out-of-range hour", async () => {
      expect((await extract({ timeOfDay: "25:00" })).timeOfDay).toBeNull();
    });

    it("rejects an out-of-range minute", async () => {
      expect((await extract({ timeOfDay: "12:60" })).timeOfDay).toBeNull();
    });
  });

  describe("cadenceKind validation", () => {
    it("normalizes known cadence kinds to lowercase", async () => {
      expect((await extract({ cadenceKind: "WEEKLY" })).cadenceKind).toBe(
        "weekly",
      );
    });

    it("rejects unknown cadence kinds", async () => {
      expect((await extract({ cadenceKind: "fortnightly" })).cadenceKind).toBe(
        null,
      );
    });
  });

  describe("priority clamping", () => {
    it("clamps below-range values to 1", async () => {
      expect((await extract({ priority: 0 })).priority).toBe(1);
      expect((await extract({ priority: -3 })).priority).toBe(1);
    });

    it("clamps above-range values to 5", async () => {
      expect((await extract({ priority: 8 })).priority).toBe(5);
    });

    it("rounds fractional priorities", async () => {
      expect((await extract({ priority: 3.4 })).priority).toBe(3);
      expect((await extract({ priority: 3.6 })).priority).toBe(4);
    });
  });

  describe("weekdays and windows", () => {
    it("keeps weekday numbers in range", async () => {
      const fields = await extract({ weekdays: [0, 6] });
      expect(fields.weekdays).toEqual([0, 6]);
    });

    it("filters out-of-range weekdays and returns null when none remain", async () => {
      const fields = await extract({ weekdays: [7, -1] });
      expect(fields.weekdays).toBeNull();
    });

    it("trims and filters window strings", async () => {
      const fields = await extract({ windows: [" morning ", "", 5] });
      expect(fields.windows).toEqual(["morning"]);
    });
  });

  describe("numeric fields", () => {
    it("accepts non-negative integers", async () => {
      const fields = await extract({ dueInDays: 1, dueInMinutes: 120 });
      expect(fields.dueInDays).toBe(1);
      expect(fields.dueInMinutes).toBe(120);
    });

    it("rejects fractional and negative values", async () => {
      const fields = await extract({ dueInDays: 1.5, dueInMinutes: -5 });
      expect(fields.dueInDays).toBeNull();
      expect(fields.dueInMinutes).toBeNull();
    });

    it("rejects zero and negative everyMinutes", async () => {
      const fields = await extract({ everyMinutes: 0 });
      expect(fields.everyMinutes).toBeNull();
    });
  });

  describe("boolean passthrough", () => {
    it("keeps explicit checkInRequested booleans", async () => {
      expect((await extract({ checkInRequested: true })).checkInRequested).toBe(
        true,
      );
      expect(
        (await extract({ checkInRequested: false })).checkInRequested,
      ).toBe(false);
    });

    it("rejects non-boolean checkInRequested", async () => {
      expect(
        (await extract({ checkInRequested: "yes" })).checkInRequested,
      ).toBeNull();
    });
  });
});

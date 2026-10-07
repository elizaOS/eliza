// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import {
  type IAgentRuntime,
  type Memory,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatCalendarEventTimeRange,
  formatRelativeMinutes,
  messageSource,
  messageText,
  parseLifeOpsJsonRecord,
  runLifeOpsJsonModel,
  toActionData,
} from "../src/lifeops/google/format-helpers.js";

/**
 * Pure helpers behind the LifeOps Google (calendar/gmail) action surface:
 * typed accessors that pull a value out of an untyped detail record (and return
 * undefined rather than a wrong-typed value), safe message field reads, model
 * JSON parsing that tolerates junk, and relative-time formatting.
 */

const mem = (content: unknown): Memory => ({ content }) as unknown as Memory;

describe("message field accessors", () => {
  it("read source/text only when they are strings", () => {
    expect(messageSource(mem({ source: "discord" }))).toBe("discord");
    expect(messageSource(mem({ source: 5 }))).toBeNull();
    expect(messageText(mem({ text: "hi" }))).toBe("hi");
    expect(messageText(mem({}))).toBe("");
  });
});

describe("detail accessors", () => {
  const details = {
    name: "  Ada  ",
    blank: "   ",
    count: 3,
    nan: Number.NaN,
    flag: false,
    obj: { a: 1 },
    arr: [1, 2],
  };

  it("return correctly-typed values, undefined on mismatch", () => {
    expect(detailString(details, "name")).toBe("Ada"); // trimmed
    expect(detailString(details, "blank")).toBeUndefined();
    expect(detailNumber(details, "count")).toBe(3);
    expect(detailNumber(details, "nan")).toBeUndefined();
    expect(detailBoolean(details, "flag")).toBe(false);
    expect(detailObject(details, "obj")).toEqual({ a: 1 });
    expect(detailObject(details, "arr")).toBeUndefined(); // arrays are not objects here
    expect(detailArray(details, "arr")).toEqual([1, 2]);
    expect(detailArray(details, "obj")).toBeUndefined();
  });
});

describe("parseLifeOpsJsonRecord", () => {
  it("parses a JSON object, null for non-object/garbage", () => {
    expect(parseLifeOpsJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(parseLifeOpsJsonRecord("not json")).toBeNull();
  });
});

describe("formatRelativeMinutes", () => {
  it("renders now / minutes / hours+minutes", () => {
    expect(formatRelativeMinutes(0)).toBe("now");
    expect(formatRelativeMinutes(-5)).toBe("now");
    expect(formatRelativeMinutes(25)).toBe("in 25 min");
    expect(formatRelativeMinutes(60)).toBe("in 1h");
    expect(formatRelativeMinutes(90)).toBe("in 1h 30m");
  });
});

describe("formatCalendarEventTimeRange", () => {
  it.each([
    [
      "America/Los_Angeles",
      "2026-10-06T18:00:00Z",
      "2026-10-06T18:15:00Z",
      "Oct 6, 2026, 11:00 AM – 11:15 AM PDT",
    ],
    [
      "Asia/Tokyo",
      "2026-10-06T18:00:00Z",
      "2026-10-06T18:15:00Z",
      "Oct 7, 2026, 3:00 AM – 3:15 AM GMT+9",
    ],
    [
      "Asia/Kathmandu",
      "2026-10-06T18:00:00Z",
      "2026-10-06T18:15:00Z",
      "Oct 6, 2026, 11:45 PM – Oct 7, 2026, 12:00 AM GMT+5:45",
    ],
    [
      "America/New_York",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:45:00Z",
      "Nov 1, 2026, 1:30 AM EDT – 1:45 AM EST",
    ],
    [
      "America/New_York",
      "2026-03-08T06:30:00Z",
      "2026-03-08T07:30:00Z",
      "Mar 8, 2026, 1:30 AM EST – 3:30 AM EDT",
    ],
    [
      "UTC",
      "2026-12-31T23:45:00Z",
      "2027-01-01T00:15:00Z",
      "Dec 31, 2026, 11:45 PM – Jan 1, 2027, 12:15 AM UTC",
    ],
  ])(
    "keeps %s ranges concise without losing date or offset transitions",
    (timezone, startAt, endAt, expected) => {
      expect(formatCalendarEventTimeRange({ startAt, endAt, timezone })).toBe(
        expected,
      );
    },
  );

  it("uses explicit UTC when the timezone is unknown and rejects invalid zones honestly", () => {
    const event = {
      startAt: "2026-10-06T18:00:00Z",
      endAt: "2026-10-06T18:15:00Z",
    };
    expect(formatCalendarEventTimeRange(event)).toBe(
      "Oct 6, 2026, 6:00 PM – 6:15 PM UTC",
    );
    expect(
      formatCalendarEventTimeRange({ ...event, timezone: "invalid/zone" }),
    ).toBe("timezone unavailable");
  });

  it.each([
    ["2026-10-07", "2026-10-08", "Oct 7, 2026, all day"],
    [
      "2026-10-07T00:00:00.000Z",
      "2026-10-10T00:00:00.000Z",
      "Oct 7, 2026 – Oct 9, 2026, all day",
    ],
    ["2026-11-01", "2026-11-03", "Nov 1, 2026 – Nov 2, 2026, all day"],
    ["2026-12-31", "2027-01-02", "Dec 31, 2026 – Jan 1, 2027, all day"],
  ])(
    "preserves civil all-day range %s through exclusive %s",
    (startAt, endAt, expected) => {
      for (const timezone of [
        "America/Los_Angeles",
        "Asia/Kolkata",
        "America/New_York",
        "invalid/zone",
      ]) {
        expect(
          formatCalendarEventTimeRange({
            startAt,
            endAt,
            timezone,
            isAllDay: true,
          }),
        ).toBe(expected);
      }
    },
  );

  it.each([
    ["invalid", "2026-10-08", "all day (date unavailable)"],
    ["2026-10-07", "invalid", "all day (date unavailable)"],
    ["2026-02-30", "2026-03-03", "all day (date unavailable)"],
    ["2026-10-07", "2026-10-07", "all day (date range unavailable)"],
    ["2026-10-08", "2026-10-07", "all day (date range unavailable)"],
  ])(
    "does not invent an all-day date for %s through %s",
    (startAt, endAt, expected) => {
      expect(
        formatCalendarEventTimeRange({ startAt, endAt, isAllDay: true }),
      ).toBe(expected);
    },
  );

  it.each([
    ["invalid", "invalid", "time unavailable"],
    [
      "invalid",
      "2026-10-06T18:15:00Z",
      "start time unavailable – Oct 6, 2026, 11:15 AM PDT",
    ],
    [
      "2026-10-06T18:00:00Z",
      "invalid",
      "Oct 6, 2026, 11:00 AM PDT – end time unavailable",
    ],
  ])(
    "retains known endpoints when %s – %s is malformed",
    (startAt, endAt, expected) => {
      expect(
        formatCalendarEventTimeRange({
          startAt,
          endAt,
          timezone: "America/Los_Angeles",
        }),
      ).toBe(expected);
    },
  );
});

describe("toActionData", () => {
  it("shallow-copies an object into a provider data record", () => {
    expect(toActionData({ a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
  });
});

it.each([
  { temperature: undefined, native: false },
  { temperature: 0, native: false },
  { temperature: 0.4, native: false },
  { temperature: 0, native: true },
])(
  "preserves extraction options and parses provider output ($temperature, native=$native)",
  async ({ temperature, native }) => {
    const responseSchema = {
      type: "object" as const,
      properties: { title: { type: "string" as const } },
      required: ["title"],
      additionalProperties: false,
    };
    const useModel = vi.fn(async () =>
      native
        ? { text: '{"title":"Renamed"}', toolCalls: [], finishReason: "stop" }
        : '{"title":"Renamed"}',
    );
    const runtime = {
      useModel,
      logger: { warn: vi.fn() },
    } as unknown as IAgentRuntime;
    const result = await runWithTrajectoryContext(
      {
        trajectoryId: "calendar-extraction",
        trajectoryStepId: "extract",
        purpose: "action",
      },
      () =>
        runLifeOpsJsonModel({
          runtime,
          prompt: "Extract the proposed title",
          responseSchema,
          actionType: "lifeops.calendar.extract_update_event",
          failureMessage: "Extraction failed",
          source: "action:calendar",
          ...(temperature === undefined ? {} : { temperature }),
        }),
    );
    expect(result?.parsed).toEqual({ title: "Renamed" });
    expect(useModel).toHaveBeenCalledExactlyOnceWith(ModelType.TEXT_LARGE, {
      prompt: "Extract the proposed title",
      responseSchema,
      ...(temperature === undefined ? {} : { temperature }),
    });
  },
);

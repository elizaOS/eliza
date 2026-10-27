import { describe, expect, it } from "vitest";
import {
  CLOCK_ALARMS_CAPABILITY,
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  type ClockHandoffOperation,
} from "./clock-contract.ts";
import {
  assertClockHandoffObservation,
  assertClockHandoffTimeZone,
  buildClockHandoffRequest,
  clockHandoffCapabilities,
  clockHandoffFormDays,
  clockHandoffReceipt,
  describeClockDays,
  describeClockHandoff,
  isClockHandoffOperation,
  normalizeClockTimeZone,
  validateClockHandoffDispatch,
  validateClockHandoffResult,
} from "./clock-handoff.ts";

const set = (extra: Record<string, unknown> = {}) => ({
  type: "clock_handoff",
  action: "set",
  hour: 7,
  minute: 5,
  label: "Gym",
  timeZone: "Europe/London",
  ...extra,
});
const everyOffer = [
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  CLOCK_ALARMS_CAPABILITY,
];

describe("external Clock handoff capability policy", () => {
  it("advertises handoffs only, never owned alarms", () => {
    expect(
      clockHandoffCapabilities({
        offered: everyOffer,
        handler: true,
        repeatDays: true,
      }),
    ).toEqual([CLOCK_CAPABILITY, CLOCK_REPEAT_CAPABILITY]);
    expect(
      clockHandoffCapabilities({
        offered: everyOffer,
        handler: true,
        repeatDays: false,
      }),
    ).toEqual([CLOCK_CAPABILITY]);
  });

  it("advertises nothing without a Clock handler or an agent offer", () => {
    expect(
      clockHandoffCapabilities({
        offered: everyOffer,
        handler: false,
        repeatDays: true,
      }),
    ).toEqual([]);
    expect(
      clockHandoffCapabilities({
        offered: [CLOCK_ALARMS_CAPABILITY],
        handler: true,
        repeatDays: true,
      }),
    ).toEqual([]);
    expect(
      clockHandoffCapabilities({
        offered: [CLOCK_REPEAT_CAPABILITY],
        handler: true,
        repeatDays: true,
      }),
    ).toEqual([CLOCK_REPEAT_CAPABILITY]);
    expect(
      clockHandoffCapabilities({
        offered: "clock.handoff.v1" as unknown as unknown[],
        handler: true,
        repeatDays: true,
      }),
    ).toEqual([]);
  });
});

describe("handoff dispatch validation", () => {
  it("refuses owned-alarm operations and unknown shapes", () => {
    expect(() =>
      validateClockHandoffDispatch({
        type: "clock_alarm",
        action: "show",
      }),
    ).toThrow();
    expect(() => validateClockHandoffDispatch(set({ extra: 1 }))).toThrow();
    expect(isClockHandoffOperation({ type: "clock_alarm" })).toBe(false);
    expect(isClockHandoffOperation(set())).toBe(true);
  });

  it("dispatches an explicit empty repeat as a one-off and sorts days", () => {
    expect(validateClockHandoffDispatch(set({ days: [] }))).toEqual(set());
    expect(validateClockHandoffDispatch(set())).toEqual(set());
    expect(validateClockHandoffDispatch(set({ days: [7, 1] }))).toEqual(
      set({ days: [1, 7] }),
    );
    expect(() => validateClockHandoffDispatch(set({ days: [2, 2] }))).toThrow();
    expect(() => validateClockHandoffDispatch(set({ days: [0] }))).toThrow();
  });

  it("keeps non-set actions exact", () => {
    expect(
      validateClockHandoffDispatch({
        type: "clock_handoff",
        action: "snooze",
        snoozeMinutes: 10,
      }),
    ).toEqual({ type: "clock_handoff", action: "snooze", snoozeMinutes: 10 });
    expect(() =>
      validateClockHandoffDispatch({
        type: "clock_handoff",
        action: "snooze",
        snoozeMinutes: 61,
      }),
    ).toThrow();
  });
});

describe("owner-facing review text", () => {
  it("names the product and never claims creation or ringing", () => {
    const text = describeClockHandoff(
      validateClockHandoffDispatch(set({ days: [6, 2, 3, 4, 5] })),
      "Alpha",
    );
    expect(text).toBe(
      "Ask Clock to set 07:05 in Europe/London, repeating weekdays named “Gym”. Review the alarm in Clock; Alpha cannot confirm creation or ringing.",
    );
    const dismiss = describeClockHandoff(
      { type: "clock_handoff", action: "dismiss" },
      "Eliza",
    );
    expect(dismiss).toContain("Eliza will not dismiss or disable");
    expect(dismiss).toContain("Completion stays unverified.");
    expect(
      describeClockHandoff(
        { type: "clock_handoff", action: "snooze", snoozeMinutes: 9 },
        "Eliza",
      ),
    ).toContain("9 minutes will not be applied automatically");
    expect(
      describeClockHandoff({ type: "clock_handoff", action: "show" }, "Eliza"),
    ).toBe("Open Clock’s alarms page.");
  });

  it("summarizes repeat days", () => {
    expect(describeClockDays([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(describeClockDays([7, 1])).toBe("weekends");
    expect(describeClockDays([4, 2])).toBe("Mon, Wed");
  });
});

describe("time zones and receipts", () => {
  it("normalizes the ISO zero offset only", () => {
    expect(normalizeClockTimeZone("+00:00")).toBe("UTC");
    expect(normalizeClockTimeZone("-00:00")).toBe("UTC");
    expect(normalizeClockTimeZone("America/New_York")).toBe("America/New_York");
    expect(() => normalizeClockTimeZone("+01:00")).toThrow();
    expect(() => normalizeClockTimeZone("Mars/Base")).toThrow();
  });

  it("refuses a set request whose reviewed zone no longer matches", () => {
    const operation = validateClockHandoffDispatch(set());
    expect(() =>
      assertClockHandoffTimeZone(operation, "Europe/London", "Europe/London"),
    ).not.toThrow();
    expect(() =>
      assertClockHandoffTimeZone(operation, "UTC", "Europe/London"),
    ).toThrow("Phone time zone changed");
    expect(() =>
      assertClockHandoffTimeZone(operation, "Europe/London", "UTC"),
    ).toThrow("Phone time zone changed");
    expect(() =>
      assertClockHandoffTimeZone(
        { type: "clock_handoff", action: "show" },
        undefined,
        "UTC",
      ),
    ).not.toThrow();
    expect(() =>
      assertClockHandoffObservation(operation, {
        sensitive: false,
        revision: 1,
        timeZone: "Europe/London",
      }),
    ).not.toThrow();
    expect(() =>
      assertClockHandoffObservation(operation, {
        sensitive: false,
        revision: 1,
        timeZone: "UTC",
      }),
    ).toThrow();
  });

  it("binds native statuses: opened is applied, unknown stays unknown", () => {
    const operation = validateClockHandoffDispatch(
      set(),
    ) as ClockHandoffOperation;
    const opened = { kind: "clock-handoff", action: "set", status: "opened" };
    expect(clockHandoffReceipt(operation, opened)).toEqual(opened);
    expect(
      clockHandoffReceipt(operation, { ...opened, status: "unknown" }).status,
    ).toBe("unknown");
    expect(
      clockHandoffReceipt(operation, { ...opened, status: "denied" }).status,
    ).toBe("denied");
    expect(() =>
      clockHandoffReceipt(operation, { ...opened, status: "scheduled" }),
    ).toThrow();
    expect(() =>
      clockHandoffReceipt(operation, { ...opened, action: "show" }),
    ).toThrow();
    expect(() =>
      validateClockHandoffResult(operation, opened, "unknown"),
    ).toThrow();
    expect(() =>
      validateClockHandoffResult(
        { type: "clock_alarm", action: "show" } as never,
        opened,
        "applied",
      ),
    ).toThrow();
  });
});

describe("phone form builder", () => {
  it("builds one-off and repeating set requests", () => {
    expect(
      buildClockHandoffRequest(
        { action: "set", time: "06:30", label: " Run ", snooze: "", days: [] },
        "UTC",
      ),
    ).toEqual({
      action: "set",
      hour: 6,
      minute: 30,
      label: "Run",
      timeZone: "UTC",
      reviewed: true,
    });
    expect(
      buildClockHandoffRequest(
        { action: "set", time: "06:30", label: "", snooze: "", days: [3, 2] },
        "UTC",
      ),
    ).toMatchObject({ days: [2, 3] });
  });

  it("refuses invalid times, labels, snoozes and repeat days", () => {
    const base = { action: "set" as const, label: "", snooze: "", days: [] };
    expect(() =>
      buildClockHandoffRequest({ ...base, time: "24:00" }, "UTC"),
    ).toThrow();
    expect(() =>
      buildClockHandoffRequest(
        { ...base, time: "07:00", label: "x".repeat(201) },
        "UTC",
      ),
    ).toThrow();
    expect(() =>
      buildClockHandoffRequest({ ...base, time: "07:00", days: [1, 1] }, "UTC"),
    ).toThrow("Invalid Clock repeat days");
    expect(() =>
      buildClockHandoffRequest(
        { action: "snooze", time: "", label: "", snooze: "0", days: [] },
        "UTC",
      ),
    ).toThrow();
    expect(
      buildClockHandoffRequest(
        { action: "snooze", time: "", label: "", snooze: "15", days: [] },
        "UTC",
      ),
    ).toEqual({ action: "snooze", snoozeMinutes: 15, reviewed: true });
    expect(
      buildClockHandoffRequest(
        { action: "dismiss", time: "", label: "", snooze: "", days: [] },
        "UTC",
      ),
    ).toEqual({ action: "dismiss", reviewed: true });
    expect(() => clockHandoffFormDays([])).toThrow();
    expect(clockHandoffFormDays([7, 1, 3])).toEqual([1, 3, 7]);
  });
});

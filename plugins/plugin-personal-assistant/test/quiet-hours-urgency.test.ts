// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  isReminderChannelAllowedForUrgency,
  isWithinQuietHours,
  parseQuietHoursPolicy,
  priorityToUrgency,
} from "../src/lifeops/service-helpers-misc.js";

/**
 * Quiet-hours + urgency gating decides whether a reminder may fire on a channel
 * right now (#8795). The window math must respect timezone and overnight wrap,
 * and urgency must gate intrusive channels — a bug here means a 3am voice call.
 */

// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime validator with loose input.
const qh = (o: Record<string, unknown>): any => o;
const at = (iso: string): Date => new Date(iso);

describe("parseQuietHoursPolicy", () => {
  it("accepts a well-formed policy and rejects malformed input", () => {
    const parsed = parseQuietHoursPolicy(
      qh({
        timezone: "UTC",
        startMinute: 1320,
        endMinute: 420,
        channels: ["voice"],
      }),
    );
    expect(parsed).toMatchObject({
      timezone: "UTC",
      startMinute: 1320,
      endMinute: 420,
    });
    expect(parsed?.channels.has("voice")).toBe(true);

    expect(parseQuietHoursPolicy(qh("nope"))).toBeNull();
    expect(
      parseQuietHoursPolicy(qh({ timezone: "UTC", startMinute: 0 })),
    ).toBeNull();
    expect(
      parseQuietHoursPolicy(
        qh({ timezone: "Mars/Phobos", startMinute: 0, endMinute: 60 }),
      ),
    ).toBeNull();
    expect(
      parseQuietHoursPolicy(
        qh({ timezone: "UTC", startMinute: 1500, endMinute: 60 }),
      ),
    ).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  const window = (start: number, end: number, channels?: string[]) =>
    qh({
      timezone: "UTC",
      startMinute: start,
      endMinute: end,
      ...(channels ? { channels } : {}),
    });

  it("returns false for an absent/invalid policy", () => {
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T03:00:00Z"),
        quietHours: qh(null),
        channel: "voice",
      }),
    ).toBe(false);
  });

  it("handles a same-day window", () => {
    const quietHours = window(540, 1020); // 09:00–17:00
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T10:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T18:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(false);
  });

  it("handles an overnight (wrapping) window", () => {
    const quietHours = window(1320, 420); // 22:00–07:00
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T23:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T05:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T12:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(false);
  });

  it("only applies to listed channels when a channel filter is set", () => {
    const quietHours = window(540, 1020, ["voice"]);
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T10:00:00Z"),
        quietHours,
        channel: "in_app",
      }),
    ).toBe(false); // not in the quiet-channel set
    expect(
      isWithinQuietHours({
        now: at("2026-06-23T10:00:00Z"),
        quietHours,
        channel: "voice",
      }),
    ).toBe(true);
  });
});

describe("urgency gating", () => {
  it("maps priority to urgency", () => {
    expect(priorityToUrgency(1)).toBe("critical");
    expect(priorityToUrgency(0)).toBe("critical");
    expect(priorityToUrgency(2)).toBe("high");
    expect(priorityToUrgency(3)).toBe("medium");
    expect(priorityToUrgency(9)).toBe("low");
  });

  it("gates intrusive channels by urgency", () => {
    expect(isReminderChannelAllowedForUrgency("in_app", "low")).toBe(true);
    expect(isReminderChannelAllowedForUrgency("voice", "high")).toBe(true);
    expect(isReminderChannelAllowedForUrgency("voice", "medium")).toBe(false);
    expect(isReminderChannelAllowedForUrgency("sms", "low")).toBe(false);
    expect(isReminderChannelAllowedForUrgency("sms", "medium")).toBe(true);
    expect(isReminderChannelAllowedForUrgency("discord", "low")).toBe(false);
    expect(isReminderChannelAllowedForUrgency("discord", "high")).toBe(true);
  });
});

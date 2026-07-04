// Exercises LifeOps domain priority and notification behavior.
import { describe, expect, it } from "vitest";
import {
  REMINDER_DISTANT_WINDOW_MS,
  REMINDER_SOON_WINDOW_MS,
  resolveReminderNotificationPriority,
} from "./reminder-notification-priority.ts";

/**
 * Calendar-reminder priority tiering (#10697). "Starting soon" must outrank
 * "tomorrow" on the notification rail; a regression that flattens them back to a
 * single tier is exactly what this issue fixes, so the soon/later/distant edges
 * are pinned.
 */
const NOW = 1_700_000_000_000;
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const priority = (
  ownerType: "occurrence" | "calendar_event",
  dueAt: string | null,
) => resolveReminderNotificationPriority({ ownerType, dueAt, nowMs: NOW });

describe("resolveReminderNotificationPriority", () => {
  it("tiers a calendar event starting SOON (≤ 2h) as high", () => {
    expect(priority("calendar_event", at(10 * 60_000))).toBe("high"); // 10 min
    expect(priority("calendar_event", at(REMINDER_SOON_WINDOW_MS))).toBe(
      "high",
    ); // exactly 2h
  });

  it("treats an overdue / just-started calendar event as high", () => {
    expect(priority("calendar_event", at(-5 * 60_000))).toBe("high"); // 5 min ago
  });

  it("tiers a calendar event TOMORROW / further out (≥ 12h) as low", () => {
    expect(priority("calendar_event", at(REMINDER_DISTANT_WINDOW_MS))).toBe(
      "low",
    ); // exactly 12h
    expect(priority("calendar_event", at(30 * 60 * 60_000))).toBe("low"); // 30h
  });

  it("tiers a calendar event LATER TODAY (2h–12h) as normal", () => {
    expect(priority("calendar_event", at(6 * 60 * 60_000))).toBe("normal");
  });

  it("keeps non-calendar reminders at normal regardless of lead time", () => {
    expect(priority("occurrence", at(10 * 60_000))).toBe("normal");
    expect(priority("occurrence", at(30 * 60 * 60_000))).toBe("normal");
  });

  it("falls back to normal for a missing / unparseable dueAt", () => {
    expect(priority("calendar_event", null)).toBe("normal");
    expect(priority("calendar_event", "not-a-date")).toBe("normal");
  });
});

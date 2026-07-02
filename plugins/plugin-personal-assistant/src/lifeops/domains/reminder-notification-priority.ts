/**
 * Notification-priority tiering for reminders pushed onto the unified rail
 * (#10697). Calendar-event reminders were all emitted at a single fixed
 * `priority: "normal"`, so "starting soon" and "tomorrow" looked identical on
 * the notification surface. This tiers a calendar reminder by how far away the
 * event actually starts:
 *
 *   - starting SOON (≤ {@link REMINDER_SOON_WINDOW_MS}, incl. overdue) → "high",
 *   - TOMORROW / further out (≥ {@link REMINDER_DISTANT_WINDOW_MS})    → "low",
 *   - later today (in between)                                        → "normal".
 *
 * Non-calendar reminders keep "normal" (this issue only tiers calendar events).
 *
 * The event start time is the reminder's `dueAt` — for a `calendar_event` row
 * `dueAt` is set to `event.startAt` (the nudge's own fire time lives in
 * `scheduledFor`), so `dueAt - now` is the true lead time to the event. Pure +
 * time-injected so it unit-tests without a clock.
 */

export type ReminderNotificationPriority = "low" | "normal" | "high";

/** Lead time at/under which an event counts as "starting soon" (matches the
 * calendar widget's ≤2h urgent window). */
export const REMINDER_SOON_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Lead time at/beyond which an event counts as "tomorrow or further out". */
export const REMINDER_DISTANT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

export function resolveReminderNotificationPriority(args: {
  ownerType: "occurrence" | "calendar_event";
  /** For a `calendar_event` this is the EVENT START time (`event.startAt`). */
  dueAt: string | null;
  nowMs: number;
}): ReminderNotificationPriority {
  // Only calendar events tier by lead time; other reminders stay normal.
  if (args.ownerType !== "calendar_event" || !args.dueAt) return "normal";
  const startMs = Date.parse(args.dueAt);
  if (!Number.isFinite(startMs)) return "normal";

  const leadMs = startMs - args.nowMs;
  // Overdue / imminent events are urgent-adjacent → high.
  if (leadMs <= REMINDER_SOON_WINDOW_MS) return "high";
  if (leadMs >= REMINDER_DISTANT_WINDOW_MS) return "low";
  return "normal";
}

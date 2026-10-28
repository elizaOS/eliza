/**
 * Browser-safe twin of the Android `ReminderStore` civil schedule and occurrence
 * decisions. Hosts that keep reminder rows outside Android (a browser build or a
 * desktop shell) use these pure functions so one-off completion, completion-driven
 * repeats, skipped dates, snooze and retained history match the shared engine.
 *
 * Storage, notification delivery, permission state, row identities and receipts
 * stay with the host. Nothing here schedules an alert or reads a clock: callers
 * pass the instant and the delivery status they observed.
 */
import type { AndroidReminderRecurrence } from "./android-definitions.js";

export type ReminderRecurrence = AndroidReminderRecurrence;

/** Snooze delay used by the shared engine's notification action. */
export const REMINDER_SNOOZE_MS = 600_000;
/** Completed occurrences retained per reminder, newest last. */
export const REMINDER_HISTORY_LIMIT = 32;

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Bound for corrupt or centuries-old saved schedules. */
const MAX_REPEAT_STEPS = 40_000;

function civil(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw Error("Invalid reminder date or time.");
  const value = Date.parse(`${date}T${time}:00Z`);
  if (
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 16) !== `${date}T${time}`
  )
    throw Error("Invalid reminder date or time.");
  return value;
}

/** Wall-clock reading in the saved zone, encoded as a UTC epoch. */
function zoneClock(zone: string): (instant: number) => number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (instant) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return Date.parse(
      `${String(parts.year).padStart(4, "0")}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
  };
}

/**
 * The earlier instant at an overlap. A future gap advances to the first valid
 * wall time after it, as the native engine does; an initial gap is refused.
 * Every calculation uses the saved zone, never the host zone.
 */
function resolveWall(
  wall: number,
  local: (instant: number) => number,
  allowGap: boolean,
): number {
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const probe = wall + hours * 3_600_000;
    offsets.add(local(probe) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  const exact = candidates.find((instant) => local(instant) === wall);
  if (exact !== undefined) return exact;
  if (!allowGap) throw Error("This local time does not exist.");
  // Only the transition bracket is searched; half-hour and skipped-day gaps included.
  for (
    let instant = candidates[0];
    instant <= candidates[candidates.length - 1];
    instant += MINUTE
  )
    if (local(instant) >= wall) return instant;
  throw Error("Unable to resolve reminder time.");
}

function validate(rule: ReminderRecurrence) {
  if (
    !rule ||
    !["daily", "weekdays", "weekly"].includes(rule.rule) ||
    !Number.isInteger(rule.leadMinutes) ||
    rule.leadMinutes < 0 ||
    rule.leadMinutes > 10080
  )
    throw Error("Invalid reminder repeat rule.");
  let local: (instant: number) => number;
  try {
    local = zoneClock(rule.zone);
  } catch {
    throw Error("Invalid reminder repeat rule.");
  }
  return { wall: civil(rule.date, rule.time), local };
}

const weekend = (day: number) => [0, 6].includes(new Date(day).getUTCDay());

/** Due instant of a new repeat; `at` must equal it minus the alert lead. */
export function initialReminderDue(
  rule: ReminderRecurrence,
  at: number,
): number {
  const { wall, local } = validate(rule);
  if (rule.rule === "weekdays" && weekend(wall))
    throw Error("Choose a weekday for the first occurrence.");
  const dueAt = resolveWall(wall, local, false);
  if (dueAt - rule.leadMinutes * MINUTE !== at)
    throw Error("Repeat time does not match reminder time.");
  return dueAt;
}

export interface ReminderNextOccurrence {
  dueAt: number;
  /** Alert instant: dueAt minus the lead. */
  at: number;
  /** Civil date of the occurrence in the saved zone, YYYY-MM-DD. */
  date: string;
  /** Repeat dates whose alert instant had already passed at `now`. */
  skippedDates: number;
}

/** The first repeat after the saved date whose alert instant is after `now`. */
export function nextReminderOccurrence(
  rule: ReminderRecurrence,
  now: number,
): ReminderNextOccurrence {
  const { wall, local } = validate(rule);
  if (!Number.isSafeInteger(now)) throw Error("Invalid reminder clock.");
  let day = wall;
  let skippedDates = 0;
  for (let count = 0; count < MAX_REPEAT_STEPS; count++) {
    day += (rule.rule === "weekly" ? 7 : 1) * DAY;
    if (rule.rule === "weekdays") while (weekend(day)) day += DAY;
    const dueAt = resolveWall(day, local, true);
    const at = dueAt - rule.leadMinutes * MINUTE;
    if (at > now)
      return {
        dueAt,
        at,
        date: new Date(day).toISOString().slice(0, 10),
        skippedDates,
      };
    skippedDates++;
  }
  throw Error("Reminder schedule is too old. Review its date.");
}

export interface ReminderOccurrenceHistoryEntry {
  occurrenceId: string;
  dueAt: number;
  completedAt: number;
  skippedDates: number;
}

/** The dated reminder fields an occurrence decision reads and changes. */
export interface ReminderOccurrenceRow {
  status: string;
  at: number;
  dueAt?: number;
  /** Explicit null persists a task without alerts; omitted is legacy timing. */
  alertMinutes?: number | null;
  recurrence?: ReminderRecurrence;
  occurrenceId?: string;
  history?: ReminderOccurrenceHistoryEntry[];
  completedAt?: number;
  snoozedAt?: number;
  postedAt?: number;
  legacyAlarm?: boolean;
  undated?: boolean;
}

/** Host observations for one decision. */
export interface ReminderDecisionHost {
  now: number;
  /** Delivery for a reminder that still alerts: scheduled, or permission-denied while notices are off. */
  alertStatus: "scheduled" | "permission-denied";
  /** Identity for the next repeat occurrence. Hosts keep their existing identity scheme. */
  nextOccurrenceId(): string;
}

export type ReminderDecisionStatus =
  | "completed"
  | "pending"
  | "scheduled"
  | "permission-denied";

function assertDecidable(
  row: ReminderOccurrenceRow,
  host: ReminderDecisionHost,
) {
  if (!Number.isSafeInteger(host.now)) throw Error("Invalid reminder clock.");
  if (row.undated) throw Error("Change undated to-dos from the to-do list.");
  if (row.status === "completed" || row.status === "cancelled")
    throw Error("Reminder is no longer active.");
}

/**
 * Done. A one-off reminder completes. A repeat records the finished occurrence
 * and advances to its next future civil occurrence; only an explicit Done moves
 * the schedule. History keeps the newest {@link REMINDER_HISTORY_LIMIT} entries.
 * The row is updated in place; the host persists it with a new revision.
 */
export function completeReminderOccurrence(
  row: ReminderOccurrenceRow,
  host: ReminderDecisionHost,
): ReminderDecisionStatus {
  assertDecidable(row, host);
  const next = row.recurrence
    ? nextReminderOccurrence(row.recurrence, host.now)
    : undefined;
  const occurrenceId = row.occurrenceId;
  if (typeof occurrenceId !== "string" || !occurrenceId)
    throw Error("Select the current reminder occurrence.");
  row.history = [
    ...(row.history ?? []),
    {
      occurrenceId,
      dueAt: row.dueAt ?? row.at,
      completedAt: host.now,
      skippedDates: next?.skippedDates ?? 0,
    },
  ].slice(-REMINDER_HISTORY_LIMIT);
  delete row.snoozedAt;
  delete row.postedAt;
  delete row.legacyAlarm;
  if (next && row.recurrence) {
    row.recurrence = { ...row.recurrence, date: next.date };
    row.dueAt = next.dueAt;
    row.at = next.at;
    row.occurrenceId = host.nextOccurrenceId();
    delete row.completedAt;
    row.status = row.alertMinutes === null ? "pending" : host.alertStatus;
  } else {
    row.status = "completed";
    row.completedAt = host.now;
  }
  return row.status as ReminderDecisionStatus;
}

/**
 * Snooze the current occurrence for {@link REMINDER_SNOOZE_MS}. A reminder
 * without alerts cannot be snoozed; a scheduled reminder that is already
 * snoozed is left unchanged.
 */
export function snoozeReminderOccurrence(
  row: ReminderOccurrenceRow,
  host: ReminderDecisionHost,
): Exclude<ReminderDecisionStatus, "completed" | "pending"> | "unchanged" {
  assertDecidable(row, host);
  if (row.alertMinutes === null)
    throw Error("No-alert reminders cannot be snoozed. Edit the alert first.");
  if (row.status === "scheduled" && row.snoozedAt !== undefined)
    return "unchanged";
  row.at = host.now + REMINDER_SNOOZE_MS;
  row.snoozedAt = host.now;
  delete row.legacyAlarm;
  row.status = host.alertStatus;
  return host.alertStatus;
}

/**
 * Enforcement windows for morning/night routines.
 *
 * A routine definition can opt into automatic enforcement during local
 * time-of-day windows. When an occurrence remains pending/scheduled past
 * its window start, the reminder pipeline escalates faster (and eventually
 * to alarm-level channels like voice calls).
 *
 * Canonical source of truth for "are we currently in the morning/night
 * enforcement window" — used by both the proactive worker (to decide
 * whether to plan GM/GN nudges) and the reminder mixin (to apply
 * escalation overrides).
 */

export type EnforcementWindowKind = "morning" | "night" | "none";

export interface EnforcementWindow {
  kind: EnforcementWindowKind;
  /** Minute of day in local time, inclusive. 0..1439. */
  startMinute: number;
  /** Minute of day in local time, exclusive. 1..1440. */
  endMinute: number;
}

export const DEFAULT_MORNING_WINDOW: EnforcementWindow = {
  kind: "morning",
  startMinute: 6 * 60,
  endMinute: 10 * 60,
};

export const DEFAULT_NIGHT_WINDOW: EnforcementWindow = {
  kind: "night",
  startMinute: 21 * 60,
  endMinute: 24 * 60,
};

const NONE_WINDOW: EnforcementWindow = {
  kind: "none",
  startMinute: 0,
  endMinute: 0,
};

function safeGetLocalMinuteOfDay(now: Date, timezone: string): number {
  let hour = 0;
  let minute = 0;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  for (const part of parts) {
    if (part.type === "hour") {
      const parsed = Number.parseInt(part.value, 10);
      // Intl emits "24" for midnight under hour12:false in some runtimes.
      hour = Number.isFinite(parsed) ? parsed % 24 : 0;
    } else if (part.type === "minute") {
      const parsed = Number.parseInt(part.value, 10);
      minute = Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return hour * 60 + minute;
}

function windowContains(
  window: EnforcementWindow,
  minuteOfDay: number,
): boolean {
  if (window.kind === "none") return false;
  const { startMinute, endMinute } = window;
  if (startMinute === endMinute) return false;
  // Wrapping window (e.g. 22:00 -> 02:00).
  if (startMinute > endMinute) {
    return minuteOfDay >= startMinute || minuteOfDay < endMinute;
  }
  return minuteOfDay >= startMinute && minuteOfDay < endMinute;
}

export function getCurrentEnforcementWindow(
  now: Date,
  timezone: string,
  windows?: EnforcementWindow[],
): EnforcementWindow {
  const candidates =
    windows && windows.length > 0
      ? windows
      : [DEFAULT_MORNING_WINDOW, DEFAULT_NIGHT_WINDOW];
  const minuteOfDay = safeGetLocalMinuteOfDay(now, timezone);
  for (const window of candidates) {
    if (windowContains(window, minuteOfDay)) {
      return window;
    }
  }
  return NONE_WINDOW;
}

export function isWithinEnforcementWindow(
  now: Date,
  timezone: string,
  window: EnforcementWindow,
): boolean {
  if (window.kind === "none") return false;
  const minuteOfDay = safeGetLocalMinuteOfDay(now, timezone);
  return windowContains(window, minuteOfDay);
}

/**
 * Minutes elapsed since the window's start, assuming `now` is inside the
 * window. Returns 0 when outside the window (caller should guard).
 *
 * For wrapping windows (end < start), minutes are counted from the start
 * across the day boundary.
 */
export function minutesPastWindowStart(
  now: Date,
  timezone: string,
  window: EnforcementWindow,
): number {
  if (window.kind === "none") return 0;
  if (!isWithinEnforcementWindow(now, timezone, window)) return 0;
  const minuteOfDay = safeGetLocalMinuteOfDay(now, timezone);
  if (window.startMinute > window.endMinute) {
    // Wrapping window.
    if (minuteOfDay >= window.startMinute) {
      return minuteOfDay - window.startMinute;
    }
    return 1440 - window.startMinute + minuteOfDay;
  }
  return minuteOfDay - window.startMinute;
}

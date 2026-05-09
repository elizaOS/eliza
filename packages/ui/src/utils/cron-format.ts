/**
 * cron-format — small, dependency-free helper that turns the most common
 * cron expressions into a friendly English description.
 *
 * Scope: 5-field cron (minute hour dom month dow). We don't try to handle
 * every possible expression — when an input doesn't match a recognised
 * pattern we fall back to returning the raw expression so the user at
 * least sees what's scheduled.
 *
 * Why no `cronstrue` dep: that package is ~50KB minified and pulls in a
 * full parser to cover edge cases the UI never surfaces. The Task editor
 * only offers a small set of presets plus a free-text input, so a
 * targeted formatter is enough.
 */

export interface CronPreset {
  label: string;
  expression: string;
}

/** Presets surfaced in the Task editor's recurring schedule picker. */
export const CRON_PRESETS: ReadonlyArray<CronPreset> = [
  { label: "Every hour", expression: "0 * * * *" },
  { label: "Every day at 9am", expression: "0 9 * * *" },
  { label: "Every weekday at 9am", expression: "0 9 * * 1-5" },
  { label: "Every Monday at 9am", expression: "0 9 * * 1" },
  { label: "Every 15 minutes", expression: "*/15 * * * *" },
];

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function formatTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "am" : "pm";
  if (minute === 0) return `${h12}${ampm}`;
  return `${h12}:${minute.toString().padStart(2, "0")}${ampm}`;
}

/**
 * Returns a friendly description like "Every weekday at 9am" for a small
 * set of well-known cron shapes. Returns `null` for anything we don't
 * recognise — callers should fall back to displaying the raw expression.
 */
export function describeCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return null;
  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;

  // Only month=* is supported by these presets; bail otherwise.
  if (monthPart !== "*") return null;

  // Every-N-minutes form
  const everyN = minPart.match(/^\*\/(\d+)$/);
  if (everyN && hourPart === "*" && domPart === "*" && dowPart === "*") {
    return `Every ${everyN[1]} minutes`;
  }

  if (
    minPart === "0" &&
    hourPart === "*" &&
    domPart === "*" &&
    dowPart === "*"
  ) {
    return "Every hour";
  }

  // Specific hour:minute, repeated each day or on a dow set
  const minute = Number.parseInt(minPart, 10);
  const hour = Number.parseInt(hourPart, 10);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  const time = formatTime(hour, minute);

  if (domPart === "*" && dowPart === "*") {
    return `Every day at ${time}`;
  }
  if (domPart === "*" && dowPart === "1-5") {
    return `Every weekday at ${time}`;
  }
  if (domPart === "*" && dowPart === "0,6") {
    return `Every weekend at ${time}`;
  }
  if (domPart === "*" && /^[0-6]$/.test(dowPart)) {
    const dow = Number.parseInt(dowPart, 10);
    return `Every ${DOW_NAMES[dow]} at ${time}`;
  }

  return null;
}

/**
 * Format any schedule for display: prefer the friendly description, fall
 * back to the raw expression. Always returns a non-empty string.
 */
export function formatSchedule(expression: string): string {
  const friendly = describeCron(expression);
  return friendly ?? expression;
}

/**
 * Display formatters for trajectory logs: human-readable durations (ms/s/m)
 * and timestamps for the trajectory viewer UI. Non-finite numbers and
 * unparseable ISO timestamps fail closed to the designed unavailable
 * placeholder so callers never render browser garbage such as "Invalid Date"
 * or "NaNh".
 */

const TRAJECTORY_UNAVAILABLE = "—";

/**
 * Formats a duration in milliseconds as a human-readable string. The value is
 * rounded to one decimal in the smallest unit whose magnitude is >= 1, rolling
 * over to the next unit when rounding crosses a boundary (e.g. 59.99s rounds
 * to "1.0m", 59.99m rounds to "1.0h"), so impossible values like "60.0s" or
 * "60.0m" never render.
 *
 * Null, non-finite, and negative inputs fail closed to "—".
 */
export function formatTrajectoryDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return TRAJECTORY_UNAVAILABLE;
  }
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    const rounded = Math.round(seconds * 10) / 10;
    if (rounded >= 60) return "1.0m";
    return `${rounded.toFixed(1)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    const rounded = Math.round(minutes * 10) / 10;
    if (rounded >= 60) return "1.0h";
    return `${rounded.toFixed(1)}m`;
  }
  const hours = minutes / 60;
  const roundedHours = Math.round(hours * 10) / 10;
  return `${roundedHours.toFixed(1)}h`;
}

/**
 * Formats a token count as a human-readable string, promoting to "k" at 1,000
 * and "M" at 1,000,000, including when rounding crosses the boundary
 * (e.g. 999,500 rounds to "1.0M", 1,000,000 -> "1.0M").
 *
 * Undefined, zero, non-finite, and negative counts fail closed to `emptyLabel`.
 */
export function formatTrajectoryTokenCount(
  count: number | undefined,
  options: { emptyLabel: string },
): string {
  if (
    count === undefined ||
    count === 0 ||
    !Number.isFinite(count) ||
    count < 0
  ) {
    return options.emptyLabel;
  }
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  if (thousands < 1000) {
    // Round in raw thousands so 999.5k (0.9995M) promotes to "1.0M" instead
    // of rendering the impossible "1000.0k".
    if (Math.round(thousands) >= 1000) return "1.0M";
    return `${thousands.toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Formats an ISO timestamp for the trajectory list/detail title.
 * Empty strings and values that do not parse as a finite Date fail closed to
 * "—" so the viewer never shows the browser's "Invalid Date" string.
 */
export function formatTrajectoryTimestamp(
  iso: string,
  mode: "smart" | "detailed",
): string {
  if (iso === "") return TRAJECTORY_UNAVAILABLE;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return TRAJECTORY_UNAVAILABLE;

  if (mode === "smart") {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }

    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

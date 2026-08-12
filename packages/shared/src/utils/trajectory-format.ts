/** Display formatters for trajectory logs: human-readable durations (ms/s/m) and timestamps, for the trajectory viewer UI. */

/**
 * Formats a duration in milliseconds as a human-readable string. The value is
 * rounded to one decimal in the smallest unit whose magnitude is >= 1, rolling
 * over to the next unit when rounding crosses a boundary (e.g. 59.99s rounds
 * to "1.0m", 59.99m rounds to "1.0h"), so impossible values like "60.0s" or
 * "60.0m" never render.
 */
export function formatTrajectoryDuration(ms: number | null): string {
  // Fail closed on non-finite or negative values, matching the sibling
  // formatters in format.ts (formatDurationMs / formatByteSize) that treat
  // anything not finite or negative — NaN, Infinity, -Infinity, -1 — as
  // unavailable. Without this guard a corrupt/missing durationMs renders the
  // browser garbage "NaNh" / "Infinityh" / "-1ms" instead of the designed
  // placeholder.
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
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
 */
export function formatTrajectoryTokenCount(
  count: number | undefined,
  options: { emptyLabel: string },
): string {
  // Fail closed on non-finite or negative values: NaN / Infinity / negative
  // counts render as emptyLabel rather than "NaNM" / "InfinityM". Aligns with
  // the non-negative contract of formatByteSize in format.ts.
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

export function formatTrajectoryTimestamp(
  iso: string,
  mode: "smart" | "detailed",
): string {
  // Fail closed on empty / unparseable timestamps, matching formatDateTime in
  // format.ts: empty input or a non-finite parsed Date renders the placeholder
  // instead of the browser's "Invalid Date" string.
  if (iso == null || iso === "") return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";

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

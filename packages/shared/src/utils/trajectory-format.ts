/** Display formatters for trajectory logs: human-readable durations (ms/s/m) and timestamps, for the trajectory viewer UI. */
export function formatTrajectoryDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const seconds = (ms / 1000).toFixed(1);
    // Rounding can reach the unit boundary ("60.0"); promote to minutes
    // instead of rendering an impossible seconds value.
    if (Number(seconds) < 60) return `${seconds}s`;
  }
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatTrajectoryTimestamp(
  iso: string,
  mode: "smart" | "detailed",
): string {
  const date = new Date(iso);

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

export function formatTrajectoryTokenCount(
  count: number | undefined,
  options: { emptyLabel: string },
): string {
  if (count === undefined || count === 0) return options.emptyLabel;
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const thousands = (count / 1000).toFixed(1);
    // Same boundary promotion as durations: a rounded "1000.0k" is promoted
    // to the M tier rather than displayed.
    if (Number(thousands) < 1000) return `${thousands}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

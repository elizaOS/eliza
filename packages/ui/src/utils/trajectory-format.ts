export function formatTrajectoryDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
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
  return `${(count / 1000).toFixed(1)}k`;
}

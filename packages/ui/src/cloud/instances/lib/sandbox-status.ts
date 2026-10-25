/** Theme-aware status colors and relative-time labels for sandbox displays. */

export const STATUS_DOT_COLORS: Record<string, string> = {
  running: "bg-status-success",
  provisioning: "bg-accent animate-pulse motion-reduce:animate-none",
  pending: "bg-status-warning animate-pulse motion-reduce:animate-none",
  stopped: "bg-muted",
  sleeping: "bg-muted-strong",
  disconnected: "bg-status-danger",
  error: "bg-status-danger",
};

export const STATUS_BADGE_COLORS: Record<string, string> = {
  running: "bg-status-success-bg text-status-success border-status-success",
  provisioning: "bg-accent-subtle text-accent border-accent",
  pending: "bg-status-warning-bg text-status-warning border-status-warning",
  stopped: "bg-bg-muted text-muted border-border",
  sleeping: "bg-surface text-muted-strong border-border-strong",
  disconnected: "bg-status-danger-bg text-status-danger border-status-danger",
  error: "bg-status-danger-bg text-status-danger border-status-danger",
};

export function statusDotColor(status: string): string {
  return STATUS_DOT_COLORS[status] ?? "bg-muted";
}

/** Format a date into a human-readable relative time string. */
export function formatRelative(date: Date | string | null): string {
  if (!date) return "Never";
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return "Never";
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString();
}

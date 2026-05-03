/** Shared status dot and badge color maps for sandbox/agent status display. */

export const STATUS_DOT_COLORS: Record<string, string> = {
  running: "bg-emerald-400",
  provisioning: "bg-blue-400 animate-pulse",
  pending: "bg-amber-400 animate-pulse",
  stopped: "bg-white/30",
  disconnected: "bg-orange-400",
  error: "bg-red-400",
};

export const STATUS_BADGE_COLORS: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  provisioning: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  stopped: "bg-white/5 text-white/40 border-white/10",
  disconnected: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  error: "bg-red-500/15 text-red-400 border-red-500/25",
};

export function statusDotColor(status: string): string {
  return STATUS_DOT_COLORS[status] ?? "bg-white/30";
}

export function statusBadgeColor(status: string): string {
  return STATUS_BADGE_COLORS[status] ?? "bg-white/5 text-white/40 border-white/10";
}

/** Format a date into a human-readable relative time string. */
export function formatRelative(date: Date | string | null): string {
  if (!date) return "Never";
  const d = new Date(date);
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

/** Shorter format used in compact views (omits "ago" for brevity). */
export function formatRelativeShort(date: Date | string | null): string {
  if (!date) return "—";
  const d = new Date(date);
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

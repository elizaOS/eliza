/**
 * Status dot + badge color maps and relative-time helpers for agent / sandbox
 * status display.
 *
 * Ported from `@elizaos/cloud-shared/lib/constants/sandbox-status.ts` and
 * converted to the app's semantic status tokens (see DESIGN-SYSTEM.md §2). The
 * shared version emitted raw Tailwind palette classes (`emerald`/`amber`/`red`)
 * plus `white/NN` ladders that bypass theming and break light mode. Here each
 * state maps to the theme-aware status token set:
 *   running       → status-success (the only non-brand hue permitted)
 *   provisioning  → accent (brand orange, reads as "work in progress")
 *   pending       → status-warning (orange by design)
 *   stopped       → muted / neutral surface
 *   sleeping      → muted-strong / neutral surface
 *   disconnected  → status-danger (orange by design)
 *   error         → status-danger (orange by design)
 * No blue anywhere; every class resolves correctly in light and dark.
 */

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

export function statusBadgeColor(status: string): string {
  return STATUS_BADGE_COLORS[status] ?? "bg-bg-muted text-muted border-border";
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

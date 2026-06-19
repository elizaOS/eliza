/**
 * Status dot + badge color maps and relative-time helpers for agent / sandbox
 * status display.
 *
 * Ported from `@elizaos/cloud-shared/lib/constants/sandbox-status.ts` with the
 * brand fix required by the app design rules (DECISIONS.md / root AGENTS.md):
 * **no blue anywhere**. The shared version painted the "provisioning" state
 * `bg-blue-400` / `bg-blue-500` — here it uses the brand orange instead, which
 * also reads correctly as "work in progress" alongside the amber "pending" and
 * orange "disconnected" states.
 */

export const STATUS_DOT_COLORS: Record<string, string> = {
  running: "bg-emerald-400",
  provisioning: "bg-[var(--brand-orange)] animate-pulse",
  pending: "bg-amber-400 animate-pulse",
  stopped: "bg-white/30",
  sleeping: "bg-white/45",
  disconnected: "bg-orange-400",
  error: "bg-red-400",
};

export const STATUS_BADGE_COLORS: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  provisioning:
    "bg-[var(--brand-orange)]/15 text-[var(--brand-orange)] border-[var(--brand-orange)]/25",
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  stopped: "bg-white/5 text-white/40 border-white/10",
  sleeping: "bg-white/[0.07] text-white/60 border-white/15",
  disconnected: "bg-orange-500/15 text-orange-400 border-orange-500/25",
  error: "bg-red-500/15 text-red-400 border-red-500/25",
};

export function statusDotColor(status: string): string {
  return STATUS_DOT_COLORS[status] ?? "bg-white/30";
}

export function statusBadgeColor(status: string): string {
  return (
    STATUS_BADGE_COLORS[status] ?? "bg-white/5 text-white/40 border-white/10"
  );
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

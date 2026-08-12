/**
 * Pure date/time formatters for AgentDetailPage (no React / runtime imports).
 */

export function formatDate(date: string | null): string {
  if (!date) return "—";
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTime(date: string | null): string {
  if (!date) return "";
  const timestamp = new Date(date).getTime();
  // Same finite TimeClip policy as formatDate — never surface native "Invalid Date".
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeShort(
  date: string | null,
  t: (key: string, options?: { defaultValue?: string; n?: number }) => string,
): string {
  if (!date) return t("cloud.agents.detail.never", { defaultValue: "Never" });
  const d = new Date(date);
  const timestamp = d.getTime();
  if (!Number.isFinite(timestamp))
    return t("cloud.agents.detail.never", { defaultValue: "Never" });
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)
    return t("cloud.agents.detail.justNow", { defaultValue: "Just now" });
  if (diffMin < 60)
    return t("cloud.agents.detail.minutesAgo", {
      defaultValue: "{{n}}m ago",
      n: diffMin,
    });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)
    return t("cloud.agents.detail.hoursAgo", {
      defaultValue: "{{n}}h ago",
      n: diffH,
    });
  return formatDate(date);
}

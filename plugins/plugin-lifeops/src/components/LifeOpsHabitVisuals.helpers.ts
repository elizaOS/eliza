// Pure habit/duration formatting helpers shared between LifeOpsHabitVisuals.tsx
// (the chart components) and LifeOpsOverviewSection.tsx. Split out so the .tsx
// file exports only React components and stays Fast-Refresh-compatible (Vite
// full-reloads a component file that also exports plain functions/types).

export type LifeOpsBucket = {
  key: string;
  label: string;
  totalSeconds: number;
};

export function startOfLocalDayIso(date = new Date()): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export function formatDurationSeconds(
  value: number | null | undefined,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  if (value <= 0) {
    return "0m";
  }
  const totalMinutes = Math.round(value / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

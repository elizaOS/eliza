import { formatHour } from "./helpers";
import type { TimeWindowConfig } from "./types";

export function timeWindowSummary(config: TimeWindowConfig): string {
  const hours = config.allowedHours[0];
  if (!hours) return "No hours set";
  const days = config.allowedDays.length;
  const fmtStart = formatHour(hours.start);
  const fmtEnd = formatHour(hours.end);
  return `${fmtStart}–${fmtEnd} · ${days} days`;
}

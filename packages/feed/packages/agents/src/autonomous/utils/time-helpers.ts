/**
 * Time formatting utilities for autonomous agents
 */

export { getTimeAgo } from "@feed/shared";

/**
 * Format time held in human-readable format
 * e.g., "5m", "2h 15m", "3d 4h", "1w 2d"
 */
export function formatTimeHeld(ms: number): string {
  if (ms < 60000) return "<1m";

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(ms / 86400000);
  const weeks = Math.floor(ms / 604800000);

  if (weeks > 0) {
    const remainingDays = days % 7;
    return remainingDays > 0 ? `${weeks}w ${remainingDays}d` : `${weeks}w`;
  }
  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

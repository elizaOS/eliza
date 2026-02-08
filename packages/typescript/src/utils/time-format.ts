/**
 * Time formatting utilities.
 *
 * Provides functions for human-readable time display.
 *
 * @module utils/time-format
 */

/**
 * Format a timestamp as a relative time string.
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Human-readable relative time string
 *
 * @example
 * ```ts
 * formatRelativeTime(Date.now() - 30000) // => "just now"
 * formatRelativeTime(Date.now() - 300000) // => "5m ago"
 * formatRelativeTime(Date.now() - 7200000) // => "2h ago"
 * formatRelativeTime(Date.now() - 86400000) // => "Yesterday"
 * formatRelativeTime(Date.now() - 604800000) // => "Jan 15" (or similar)
 * ```
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

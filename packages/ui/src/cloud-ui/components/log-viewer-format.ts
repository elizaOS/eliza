/**
 * Pure timestamp formatting for the cloud log viewer.
 * Kept in a .ts module so unit tests can import it without loading the React
 * component graph.
 */

export type LogViewerTimestamp = string | number | Date | null | undefined;

/**
 * Locale time label for structured log rows / refresh stamps.
 * Fail closed on empty or non-finite Date values so bad API timestamps
 * render blank instead of the browser's "Invalid Date" string.
 */
export function formatTimestamp(value: LogViewerTimestamp): string {
  if (value == null || value === "") return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toLocaleTimeString();
}

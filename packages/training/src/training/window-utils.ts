/**
 * Window Utility Functions
 * Helper functions for time-window based RL training
 */

/**
 * Get current window ID (hourly timestamp)
 * Format: YYYY-MM-DDTHH:00
 *
 * Example: "2025-01-15T10:00"
 */
export function getCurrentWindowId(): string {
  const now = new Date();
  // Round down to the start of the current hour
  const windowStart = new Date(
    Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000),
  );
  // Format as ISO string, take first 13 chars + :00
  return `${windowStart.toISOString().slice(0, 13)}:00`;
}

/**
 * Get previous window ID (N hours ago)
 *
 * @param offset - How many hours ago (default: 1)
 */
export function getPreviousWindowId(offset: number = 1): string {
  const now = new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000),
  );
  // Go back N hours
  windowStart.setHours(windowStart.getHours() - offset);
  return `${windowStart.toISOString().slice(0, 13)}:00`;
}

/**
 * Parse window ID to Date object
 *
 * @param windowId - Window ID string (YYYY-MM-DDTHH:00)
 */
export function parseWindowId(windowId: string): Date {
  return new Date(windowId);
}

/**
 * Check if a window is complete (current time is past window end)
 *
 * @param windowId - Window ID to check
 * @param windowDurationHours - Window duration (default: 1 hour)
 */
export function isWindowComplete(
  windowId: string,
  windowDurationHours: number = 1,
): boolean {
  const windowStart = parseWindowId(windowId);
  const windowEnd = new Date(
    windowStart.getTime() + windowDurationHours * 60 * 60 * 1000,
  );
  return Date.now() > windowEnd.getTime();
}

/**
 * Get window range (start and end times)
 *
 * @param windowId - Window ID
 * @param windowDurationHours - Window duration (default: 1 hour)
 */
export function getWindowRange(
  windowId: string,
  windowDurationHours: number = 1,
) {
  const start = parseWindowId(windowId);
  const end = new Date(start.getTime() + windowDurationHours * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Generate list of window IDs for a time range
 *
 * @param startTime - Start time
 * @param endTime - End time
 * @param windowDurationHours - Window duration (default: 1 hour)
 */
export function generateWindowIds(
  startTime: Date,
  endTime: Date,
  windowDurationHours: number = 1,
): string[] {
  const windows: string[] = [];
  const windowMs = windowDurationHours * 60 * 60 * 1000;

  // Round start time down to window boundary
  const currentWindowStart = new Date(
    Math.floor(startTime.getTime() / windowMs) * windowMs,
  );

  while (currentWindowStart.getTime() <= endTime.getTime()) {
    windows.push(`${currentWindowStart.toISOString().slice(0, 13)}:00`);
    currentWindowStart.setTime(currentWindowStart.getTime() + windowMs);
  }

  return windows;
}

/**
 * Get window ID for a specific timestamp
 *
 * @param timestamp - Timestamp to get window for
 * @param windowDurationHours - Window duration (default: 1 hour)
 */
export function getWindowIdForTimestamp(
  timestamp: Date,
  windowDurationHours: number = 1,
): string {
  const windowMs = windowDurationHours * 60 * 60 * 1000;
  const windowStart = new Date(
    Math.floor(timestamp.getTime() / windowMs) * windowMs,
  );
  return `${windowStart.toISOString().slice(0, 13)}:00`;
}

/**
 * Check if a timestamp falls within a window
 *
 * @param timestamp - Timestamp to check
 * @param windowId - Window ID
 * @param windowDurationHours - Window duration (default: 1 hour)
 */
export function isTimestampInWindow(
  timestamp: Date,
  windowId: string,
  windowDurationHours: number = 1,
): boolean {
  const { start, end } = getWindowRange(windowId, windowDurationHours);
  const time = timestamp.getTime();
  return time >= start.getTime() && time < end.getTime();
}

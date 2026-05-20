/**
 * Date Utilities
 * Shared date parsing and extraction utilities for the game engine.
 */

import { logger } from '@babylon/shared';

/**
 * Extract day number from timestamp string.
 * Assumes game runs in October 2025 format: "2025-10-DDTHH:MM:SSZ"
 */
export function extractDayFromTimestamp(timestamp: string): number {
  // Try ISO format: "2025-10-15T12:00:00Z"
  const isoMatch = timestamp.match(/2025-10-(\d{2})/);
  if (isoMatch) {
    return Number.parseInt(isoMatch[1]!, 10);
  }

  // Fallback: try to extract from any date format
  const dateMatch = timestamp.match(/-(\d{2})T/);
  if (dateMatch) {
    return Number.parseInt(dateMatch[1]!, 10);
  }

  return 0;
}

/**
 * Extract day number from an event object (handles different formats)
 */
export function extractDayFromEvent(event: {
  day?: number;
  timestamp?: Date | string;
}): number {
  if (event.day) return event.day;
  if (event.timestamp) {
    return extractDayFromTimestamp(
      typeof event.timestamp === 'string'
        ? event.timestamp
        : event.timestamp.toISOString()
    );
  }
  return 0;
}

/**
 * Extract day number from a post object
 */
export function extractDayFromPost(post: {
  day?: number;
  createdAt?: Date | string;
}): number {
  if (post.day) return post.day;
  if (post.createdAt) {
    return extractDayFromTimestamp(
      typeof post.createdAt === 'string'
        ? post.createdAt
        : post.createdAt.toISOString()
    );
  }
  return 0;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compute a game-relative day number (1-indexed) from a game start time.
 * Day 1 = first 24 hours from startedAt
 * Day 2 = hours 24-48, etc.
 *
 * @param startedAt - The continuous game's start timestamp
 * @param timestamp - The content/event timestamp
 * @returns 1-indexed day number since startedAt (Day 1 is first day)
 */
export function getGameDayNumber(startedAt: Date, timestamp: Date): number {
  const daysElapsed = Math.floor(
    (timestamp.getTime() - startedAt.getTime()) / MS_PER_DAY
  );
  // Clamp to minimum of 1 to handle timestamps before startedAt
  const result = Math.max(daysElapsed + 1, 1); // 1-indexed: Day 1 is first day

  // Log diagnostic warning when timestamp is before startedAt (clock drift or test data issue)
  if (timestamp.getTime() < startedAt.getTime()) {
    logger.warn(
      'getGameDayNumber: timestamp is before startedAt, clamping to day 1',
      {
        startedAt: startedAt.toISOString(),
        timestamp: timestamp.toISOString(),
        daysElapsed,
        result,
      },
      'DateUtils'
    );
  }

  return result;
}

/**
 * Validate a dayNumber for storage in Post/WorldEvent int columns.
 * Days are 1-indexed (Day 1 is the first day of the game).
 * Returns undefined for invalid day numbers to prevent DB errors.
 */
export function toSafeDayNumber(dayNumber: number): number | undefined {
  return Number.isFinite(dayNumber) && dayNumber >= 1 && dayNumber <= 2147483647
    ? dayNumber
    : undefined;
}

/**
 * Extract the date portion (YYYY-MM-DD) from a Date object.
 * Avoids the duplicate pattern: `.toISOString().split('T')[0]`
 *
 * @param date - Date object or ISO string
 * @returns Date string in YYYY-MM-DD format
 *
 * @example
 * ```typescript
 * const today = toDateString(new Date()); // "2025-01-25"
 * ```
 */
export function toDateString(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().split('T')[0] ?? '';
}

/**
 * Get today's date as YYYY-MM-DD string.
 * Convenience wrapper for common pattern.
 *
 * @returns Today's date in YYYY-MM-DD format
 */
export function getTodayDateString(): string {
  return toDateString(new Date());
}

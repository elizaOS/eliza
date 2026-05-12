/**
 * Date Utility Functions
 *
 * Shared date conversion utilities for consistent date handling across the application.
 */

/**
 * Safely convert a date value to ISO string.
 * Handles Date objects, timestamps, ISO strings, and invalid values.
 *
 * @param value - The date value to convert (Date, number, string, or unknown)
 * @returns ISO string representation of the date, or current time if conversion fails
 */
export function safeToISOString(value: unknown): string {
  if (!value) return new Date().toISOString();

  try {
    // If it's already a valid ISO string, return as-is
    if (typeof value === "string") {
      const testDate = new Date(value);
      if (!Number.isNaN(testDate.getTime())) return value;
      return new Date().toISOString();
    }

    // For numbers (timestamps) or Date-like objects
    let timestamp: number;
    if (typeof value === "number") {
      timestamp = value;
    } else {
      // Try to get timestamp from Date-like object
      const getTimeResult = (value as { getTime?: () => number })?.getTime?.();
      // Validate the returned timestamp is a valid number
      if (typeof getTimeResult === "number" && !Number.isNaN(getTimeResult)) {
        timestamp = getTimeResult;
      } else {
        timestamp = Date.now();
      }
    }

    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

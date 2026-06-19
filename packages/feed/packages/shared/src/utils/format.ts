/**
 * Formatting Utility Functions
 *
 * Pure utility functions for formatting dates, times, and numbers.
 */

/**
 * Safely converts a Date or a cached ISO string to an ISO 8601 string.
 *
 * WHY: Drizzle returns `Date` objects from a live DB connection, but after
 * JSON round-tripping through Redis cache, those fields come back as strings.
 * Calling `.toISOString()` directly on a string throws a TypeError.
 * `new Date(val)` is idempotent — works for both Date objects and ISO strings.
 *
 * @param val - A Date object or an ISO date string
 * @returns ISO 8601 string representation
 */
export function toISO(val: Date | string): string {
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

/**
 * Safely converts a nullable Date or cached ISO string to an ISO 8601 string,
 * returning null if the value is null or undefined.
 */
export function toISOOrNull(
  val: Date | string | null | undefined,
): string | null {
  if (val == null) return null;
  return toISO(val);
}

import { FEED_POINTS_SYMBOL } from "../constants/currency";

/**
 * Clamp number between min and max values
 *
 * Ensures value stays within the specified range.
 *
 * @param value - Number to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value (guaranteed to be in [min, max] range)
 *
 * @example
 * ```typescript
 * clamp(150, 0, 100); // Returns: 100
 * clamp(-10, 0, 100); // Returns: 0
 * clamp(50, 0, 100);  // Returns: 50
 * ```
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Format date/timestamp to readable date string
 *
 * Supports both Date objects and ISO timestamp strings.
 *
 * @param date - Date object or ISO timestamp string
 * @returns Formatted date string (e.g., "Jan 1, 2025")
 *
 * @example
 * ```typescript
 * formatDate(new Date()); // "Jan 16, 2025"
 * formatDate("2025-01-16T10:00:00Z"); // "Jan 16, 2025"
 * ```
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format date/timestamp to readable time string
 *
 * Supports both Date objects and ISO timestamp strings.
 *
 * @param date - Date object or ISO timestamp string
 * @returns Formatted time string (e.g., "3:45 PM")
 *
 * @example
 * ```typescript
 * formatTime(new Date()); // "3:45 PM"
 * formatTime("2025-01-16T15:45:00Z"); // "3:45 PM"
 * ```
 */
export function formatTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format date/timestamp to readable date and time string
 *
 * Supports both Date objects and ISO timestamp strings.
 *
 * @param date - Date object or ISO timestamp string
 * @returns Formatted date-time string (e.g., "Jan 16, 3:45 PM")
 *
 * @example
 * ```typescript
 * formatDateTime(new Date()); // "Jan 16, 3:45 PM"
 * formatDateTime("2025-01-16T15:45:00Z"); // "Jan 16, 3:45 PM"
 * ```
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/**
 * Calculate sentiment score from text (simple heuristic)
 *
 * Uses keyword matching to determine sentiment. Returns value between
 * -1 (negative) and 1 (positive). Returns 0 if no sentiment keywords found.
 *
 * @param text - Text to analyze
 * @returns Sentiment score between -1 and 1 (0 for neutral/no keywords)
 *
 * @example
 * ```typescript
 * calculateSentiment("This is amazing!"); // Returns: ~0.5 (positive)
 * calculateSentiment("This is terrible"); // Returns: ~-0.5 (negative)
 * ```
 */
export function calculateSentiment(text: string): number {
  const positive =
    /\b(great|amazing|success|win|best|love|excellent|awesome)\b/gi;
  const negative =
    /\b(terrible|awful|fail|worst|hate|disaster|crisis|scandal)\b/gi;

  const positiveCount = (text.match(positive) || []).length;
  const negativeCount = (text.match(negative) || []).length;

  const total = positiveCount + negativeCount;
  if (total === 0) return 0;

  return clamp((positiveCount - negativeCount) / total, -1, 1);
}

/**
 * Format relative time (e.g., "5m", "2h", "3d")
 *
 * @description Converts a date to a human-readable relative time string.
 * Shows seconds, minutes, hours, or days relative to now. Falls back to
 * formatted date for dates older than 7 days.
 *
 * @param {Date | string} date - Date to format
 * @returns {string} Relative time string (e.g., "5m", "2h", "3d") or formatted date
 *
 * @example
 * ```typescript
 * formatRelativeTime(new Date(Date.now() - 300000)) // Returns "5m"
 * formatRelativeTime(new Date(Date.now() - 86400000)) // Returns "1d"
 * ```
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return formatDate(d);
}

/**
 * Format number with K/M/B/T/Q suffixes
 *
 * @description Formats large numbers with compact suffixes.
 * Rounds to one decimal place for readability.
 *
 * @param {number} num - Number to format
 * @returns {string} Formatted number string (e.g., "1.5K", "2.3M")
 *
 * @example
 * ```typescript
 * formatCompactNumber(1500) // Returns "1.5K"
 * formatCompactNumber(2300000) // Returns "2.3M"
 * formatCompactNumber(500) // Returns "500"
 * ```
 */
export function formatCompactNumber(num: number): string {
  if (!Number.isFinite(num)) return "0";
  if (Math.abs(num) < 1e3) return num.toString();

  const sign = num < 0 ? "-" : "";
  const abs = Math.abs(num);

  if (abs >= 1e15) return `${sign}${(abs / 1e15).toFixed(1)}Q`;
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return num.toString();
}

/**
 * Options for formatCurrency function.
 */
interface FormatCurrencyOptions {
  /** Number of decimal places (default: 2) */
  decimals?: number;
  /** Whether to use thousands separators (default: false for backwards compat) */
  useThousandsSeparator?: boolean;
}

/**
 * Format number as currency
 *
 * @description Formats a number as Feed points currency with specified decimal places.
 * Uses the configured symbol (default `$`) for Feed points — not real USD.
 * Optionally includes thousands separators for better readability of large values.
 *
 * @param {number} amount - Amount to format
 * @param {number | FormatCurrencyOptions} options - Decimal places or options object
 * @returns {string} Formatted currency string (e.g., "$123.45" or "$1,234.56")
 *
 * @example
 * ```typescript
 * formatCurrency(123.456) // Returns "$123.46"
 * formatCurrency(1000, 0) // Returns "$1000"
 * formatCurrency(1234.56, { useThousandsSeparator: true }) // Returns "$1,234.56"
 * formatCurrency(1234567.89, { decimals: 2, useThousandsSeparator: true }) // Returns "$1,234,567.89"
 * ```
 */
export function formatCurrency(
  amount: number,
  options: number | FormatCurrencyOptions = 2,
): string {
  const decimals =
    typeof options === "number" ? options : (options.decimals ?? 2);
  const useThousandsSeparator =
    typeof options === "object" && options.useThousandsSeparator;

  // Handle negative numbers: sign before symbol for readability (-$100.00)
  const isNegative = amount < 0;
  const absoluteAmount = Math.abs(amount);
  const sign = isNegative ? "-" : "";

  if (useThousandsSeparator) {
    const formatted = absoluteAmount.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `${sign}${FEED_POINTS_SYMBOL}${formatted}`;
  }

  return `${sign}${FEED_POINTS_SYMBOL}${absoluteAmount.toFixed(decimals)}`;
}

/**
 * Format number as compact currency with K/M/B suffixes
 *
 * @description Formats a number as Feed points currency with K/M/B suffixes
 * for large values. Uses the configured symbol. Handles non-finite values gracefully.
 *
 * @param {number} value - Amount to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted currency string with suffix (e.g., "$1.50K", "$2.30M")
 *
 * @example
 * ```typescript
 * formatCompactCurrency(1500) // Returns "$1.50K"
 * formatCompactCurrency(2300000) // Returns "$2.30M"
 * formatCompactCurrency(1500000000) // Returns "$1.50B"
 * formatCompactCurrency(500) // Returns "$500.00"
 * formatCompactCurrency(-1500) // Returns "-$1.50K"
 * formatCompactCurrency(NaN) // Returns "$0.00"
 * ```
 */
export function formatCompactCurrency(value: number, decimals = 2): string {
  // Handle non-finite values (uses toFixed to avoid trailing dot when decimals=0)
  if (!Number.isFinite(value)) {
    return `${FEED_POINTS_SYMBOL}${(0).toFixed(decimals)}`;
  }

  // Handle negative numbers: sign should come before the symbol
  const isNegative = value < 0;
  const abs = Math.abs(value);
  const sign = isNegative ? "-" : "";

  if (abs >= 1_000_000_000) {
    return `${sign}${FEED_POINTS_SYMBOL}${(abs / 1_000_000_000).toFixed(decimals)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${FEED_POINTS_SYMBOL}${(abs / 1_000_000).toFixed(decimals)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${FEED_POINTS_SYMBOL}${(abs / 1_000).toFixed(decimals)}K`;
  }

  return `${sign}${FEED_POINTS_SYMBOL}${abs.toFixed(decimals)}`;
}

/**
 * Format number as percentage
 *
 * @description Converts a number to a percentage string, rounded to nearest integer.
 *
 * @param {number} value - Percentage value (0-100)
 * @returns {string} Formatted percentage string (e.g., "50%")
 *
 * @example
 * ```typescript
 * formatPercentage(50) // Returns "50%"
 * formatPercentage(12.3) // Returns "12%"
 * ```
 */
export function formatPercentage(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Sanitize ID for use in file paths
 *
 * @description Converts an ID string to a safe format for use in file paths and URLs.
 * Converts to lowercase, replaces spaces with hyphens, and removes special characters.
 * Returns "unknown" if ID is null or undefined.
 *
 * @param {string | undefined | null} id - ID to sanitize
 * @returns {string} Sanitized ID string safe for file paths
 *
 * @example
 * ```typescript
 * sanitizeId("My User ID!") // Returns "my-user-id"
 * sanitizeId(null) // Returns "unknown"
 * sanitizeId("user_123") // Returns "user_123"
 * ```
 */
export function sanitizeId(id: string | undefined | null): string {
  if (!id) {
    return "unknown";
  }
  return id
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .trim();
}

/**
 * Format number with K/M suffixes (alias for formatCompactNumber)
 *
 * @description Formats large numbers with K (thousands) or M (millions) suffixes.
 * Rounds to one decimal place for readability.
 *
 * @param {number} num - Number to format
 * @returns {string} Formatted number string (e.g., "1.5K", "2.3M")
 *
 * @example
 * ```typescript
 * formatNumber(1500) // Returns "1.5K"
 * formatNumber(2300000) // Returns "2.3M"
 * formatNumber(500) // Returns "500"
 * ```
 */
export function formatNumber(num: number): string {
  return formatCompactNumber(num);
}

/**
 * Format number with thousands separators (e.g., 10,000)
 *
 * @description Formats a number using locale thousands separators and a fixed
 * number of decimals. Useful for readability when you want commas instead of
 * compact K/M suffixes.
 *
 * @example
 * ```typescript
 * formatNumberWithSeparators(10000) // "10,000"
 * formatNumberWithSeparators(1234.56, { decimals: 2 }) // "1,234.56"
 * ```
 */
export function formatNumberWithSeparators(
  value: number,
  options: { decimals?: number; locale?: string } = {},
): string {
  const { decimals = 0, locale = "en-US" } = options;

  if (!Number.isFinite(value)) {
    return (0).toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  return value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a date as relative time with "ago" suffix.
 *
 * @param date - Date object, ISO string, or null/undefined
 * @returns Human-readable relative time string (e.g., "5m ago", "2h ago", "3d ago")
 *
 * @example
 * ```typescript
 * getTimeAgo(new Date(Date.now() - 300_000)) // "5m ago"
 * getTimeAgo("2025-01-16T10:00:00Z")         // "2h ago"
 * getTimeAgo(null)                            // "just now"
 * ```
 */
export function getTimeAgo(date: Date | string | null | undefined): string {
  if (date == null) return "just now";
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Escape a string for use in a RegExp constructor.
 *
 * @param str - The string to escape
 * @returns The string with all regex special characters escaped
 *
 * @example
 * ```typescript
 * new RegExp(escapeRegex('hello.world')) // matches "hello.world" literally
 * ```
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Safely convert an unknown value to a number, returning a fallback on failure.
 *
 * Handles numbers (NaN/Infinity → fallback), numeric strings, and everything else.
 *
 * @param value - The value to convert
 * @param fallback - Value to return when conversion fails (default: 0)
 * @returns The numeric value, or fallback
 *
 * @example
 * ```typescript
 * toNumber("3.14")        // 3.14
 * toNumber(42)            // 42
 * toNumber("abc")         // 0
 * toNumber(null, -1)      // -1
 * toNumber(Infinity)      // 0
 * ```
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Type guard — checks that a value is a non-empty string (after trimming).
 * Narrows `string | undefined | unknown` to `string`.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Type guard — checks that a value is a plain object (non-null, non-array).
 * Narrows `unknown` to `Record<string, unknown>`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard — checks that a value is an array of strings.
 * Narrows `unknown` to `string[]`.
 */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

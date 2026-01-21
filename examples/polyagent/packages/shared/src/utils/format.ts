/**
 * Formatting Utility Functions
 *
 * Pure utility functions for formatting dates, times, and numbers.
 */

import { POLYAGENT_POINTS_SYMBOL } from "../constants/currency";

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
 * Returns the original string on parse failure for graceful degradation.
 *
 * @param date - Date object or ISO timestamp string
 * @returns Formatted date-time string (e.g., "Jan 16, 3:45 PM")
 *
 * @example
 * ```typescript
 * formatDateTime(new Date()); // "Jan 16, 3:45 PM"
 * formatDateTime("2025-01-16T15:45:00Z"); // "Jan 16, 3:45 PM"
 * formatDateTime("invalid"); // "invalid"
 * ```
 */
export function formatDateTime(date: Date | string): string {
  try {
    const d = typeof date === "string" ? new Date(date) : date;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return typeof date === "string" ? date : String(date);
  }
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
 * Format number with K/M suffixes
 *
 * @description Formats large numbers with K (thousands) or M (millions) suffixes.
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
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
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
 * @description Formats a number as Polyagent points currency with specified decimal places.
 * Uses the ƀ symbol to represent Polyagent points (not USD or Bitcoin).
 * Optionally includes thousands separators for better readability of large values.
 *
 * @param {number} amount - Amount to format
 * @param {number | FormatCurrencyOptions} options - Decimal places or options object
 * @returns {string} Formatted currency string (e.g., "ƀ123.45" or "ƀ1,234.56")
 *
 * @example
 * ```typescript
 * formatCurrency(123.456) // Returns "ƀ123.46"
 * formatCurrency(1000, 0) // Returns "ƀ1000"
 * formatCurrency(1234.56, { useThousandsSeparator: true }) // Returns "ƀ1,234.56"
 * formatCurrency(1234567.89, { decimals: 2, useThousandsSeparator: true }) // Returns "ƀ1,234,567.89"
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

  // Handle negative numbers: keep symbol prefix, then sign
  const isNegative = amount < 0;
  const absoluteAmount = Math.abs(amount);
  const sign = isNegative ? "-" : "";

  if (useThousandsSeparator) {
    const formatted = absoluteAmount.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `${POLYAGENT_POINTS_SYMBOL}${sign}${formatted}`;
  }

  return `${POLYAGENT_POINTS_SYMBOL}${sign}${absoluteAmount.toFixed(decimals)}`;
}

/**
 * Format number as compact currency with K/M/B suffixes
 *
 * @description Formats a number as Polyagent points currency with K/M/B suffixes
 * for large values. Uses the ƀ symbol. Handles non-finite values gracefully.
 *
 * @param {number} value - Amount to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted currency string with suffix (e.g., "ƀ1.50K", "ƀ2.30M")
 *
 * @example
 * ```typescript
 * formatCompactCurrency(1500) // Returns "ƀ1.50K"
 * formatCompactCurrency(2300000) // Returns "ƀ2.30M"
 * formatCompactCurrency(1500000000) // Returns "ƀ1.50B"
 * formatCompactCurrency(500) // Returns "ƀ500.00"
 * formatCompactCurrency(-1500) // Returns "-ƀ1.50K"
 * formatCompactCurrency(NaN) // Returns "ƀ0.00"
 * ```
 */
export function formatCompactCurrency(value: number, decimals = 2): string {
  // Handle non-finite values (uses toFixed to avoid trailing dot when decimals=0)
  if (!Number.isFinite(value)) {
    return `${POLYAGENT_POINTS_SYMBOL}${(0).toFixed(decimals)}`;
  }

  // Handle negative numbers: sign should come before the symbol
  const isNegative = value < 0;
  const abs = Math.abs(value);
  const sign = isNegative ? "-" : "";

  if (abs >= 1_000_000_000) {
    return `${sign}${POLYAGENT_POINTS_SYMBOL}${(abs / 1_000_000_000).toFixed(decimals)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${POLYAGENT_POINTS_SYMBOL}${(abs / 1_000_000).toFixed(decimals)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${POLYAGENT_POINTS_SYMBOL}${(abs / 1_000).toFixed(decimals)}K`;
  }

  return `${sign}${POLYAGENT_POINTS_SYMBOL}${abs.toFixed(decimals)}`;
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

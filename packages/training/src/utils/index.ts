/**
 * Training Package Utilities
 */

export { logger } from "./logger";
export { generateSnowflakeId } from "./snowflake";
export { assertHasLLMCalls, validateLLMCalls } from "./synthetic-detector";

/**
 * Split an array into batches of a specified size
 *
 * @param items - Array to split
 * @param batchSize - Maximum size of each batch
 * @returns Array of batches
 */
export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Statistics result for numeric arrays
 */
export interface ArrayStats {
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
}

/**
 * Calculate statistics for an array of numbers
 *
 * @param values - Array of numbers
 * @returns Statistics object with mean, median, std, min, max
 */
export function calculateArrayStats(values: number[]): ArrayStats {
  if (values.length === 0) {
    return { mean: 0, median: 0, std: 0, min: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(values.length / 2)] ?? 0;
  const variance =
    values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;

  return { mean, median, std, min, max };
}

/**
 * Format a decimal value as a percentage string
 *
 * @param value - Decimal value (e.g., 0.75 for 75%)
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted percentage string (e.g., "75.0%")
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

/**
 * Format a number as currency string
 *
 * @param value - Number value
 * @param decimals - Number of decimal places (default: 2)
 * @param prefix - Currency prefix (default: "$")
 * @returns Formatted currency string (e.g., "$1,234.56")
 */
export function formatCurrency(
  value: number,
  decimals = 2,
  prefix = "$",
): string {
  const sign = value >= 0 ? "" : "-";
  return `${sign}${prefix}${Math.abs(value).toFixed(decimals)}`;
}

/**
 * Format a number as currency with explicit sign
 *
 * @param value - Number value
 * @param decimals - Number of decimal places (default: 2)
 * @param prefix - Currency prefix (default: "$")
 * @returns Formatted currency string with sign (e.g., "+$123.45" or "-$67.89")
 */
export function formatCurrencyWithSign(
  value: number,
  decimals = 2,
  prefix = "$",
): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${prefix}${Math.abs(value).toFixed(decimals)}`;
}

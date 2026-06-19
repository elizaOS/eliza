/**
 * Decimal Converter Utilities
 *
 * @description Handles safe conversion of Decimal values to strings and numbers,
 * accounting for serialization from cache (Redis) where Decimal objects may be converted
 * to strings, numbers, or plain objects. Provides type-safe conversion with fallbacks.
 */

/**
 * Safely convert a value (Decimal, number, string, or unknown) to string
 *
 * @description Converts Decimal, number, string, or serialized objects to strings
 * safely. Handles null/undefined, Decimal objects, and cached values that may have been
 * serialized differently.
 *
 * @param {unknown} value - Value that might be a Decimal, number, string, or serialized object
 * @param {string} [defaultValue='0'] - Default value if conversion fails
 * @returns {string} String representation of the value
 *
 * @example
 * ```typescript
 * // Direct from database (Decimal object)
 * const balance = toSafeString(user.virtualBalance); // "1000.50"
 *
 * // From cache (might be string, number, or object)
 * const cachedBalance = toSafeString(cachedUser.virtualBalance); // "1000.50"
 *
 * // Handle null/undefined
 * const emptyBalance = toSafeString(null); // "0"
 * ```
 */
export function toSafeString(value: unknown, defaultValue = "0"): string {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return value.toString();
  }

  // Object with toString method (like Decimal)
  if (typeof value === "object" && "toString" in value) {
    return (value as { toString: () => string }).toString();
  }

  return String(value);
}

/**
 * Safely convert a value to number
 *
 * @description Converts Decimal, number, string, or serialized objects to numbers
 * safely. Handles null/undefined, Decimal objects, and cached values. Uses parseFloat
 * for string conversion with NaN fallback.
 *
 * @param {unknown} value - Value that might be a Decimal, number, string, or serialized object
 * @param {number} [defaultValue=0] - Default value if conversion fails
 * @returns {number} Numeric representation of the value
 *
 * @example
 * ```typescript
 * const balance = toSafeNumber(user.virtualBalance); // 1000.5
 * const invalid = toSafeNumber(null); // 0
 * const custom = toSafeNumber(undefined, 100); // 100
 * ```
 */
export function toSafeNumber(value: unknown, defaultValue = 0): number {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  // Object with toString method - convert to string then parse
  if (typeof value === "object" && "toString" in value) {
    const str = (value as { toString: () => string }).toString();
    const parsed = Number.parseFloat(str);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  // Fallback: coerce to number
  const num = Number(value);
  return Number.isNaN(num) ? defaultValue : num;
}

/**
 * Convert multiple balance-related fields to strings safely
 *
 * @description Converts all balance-related fields in an object to strings using
 * toSafeString. Useful for preparing user balance data for API responses or caching.
 *
 * @param {object} balanceData - Object containing balance fields (virtualBalance, totalDeposited, etc.)
 * @returns {object} Object with all balance fields as strings
 *
 * @example
 * ```typescript
 * const balanceStrings = convertBalanceToStrings({
 *   virtualBalance: user.virtualBalance,
 *   totalDeposited: user.totalDeposited,
 *   totalWithdrawn: user.totalWithdrawn,
 *   lifetimePnL: user.lifetimePnL,
 * });
 * // Returns: { virtualBalance: "1000.50", totalDeposited: "5000.00", ... }
 * ```
 */
export function convertBalanceToStrings(balanceData: {
  virtualBalance?: unknown;
  totalDeposited?: unknown;
  totalWithdrawn?: unknown;
  lifetimePnL?: unknown;
}): {
  virtualBalance: string;
  totalDeposited: string;
  totalWithdrawn: string;
  lifetimePnL: string;
} {
  return {
    virtualBalance: toSafeString(balanceData.virtualBalance),
    totalDeposited: toSafeString(balanceData.totalDeposited),
    totalWithdrawn: toSafeString(balanceData.totalWithdrawn),
    lifetimePnL: toSafeString(balanceData.lifetimePnL),
  };
}

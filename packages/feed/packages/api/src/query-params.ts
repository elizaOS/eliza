/**
 * Query Parameter Parsing Utilities
 *
 * Common utilities for parsing and validating API query parameters.
 * Used across admin endpoints and other APIs.
 */

/**
 * Parse a date string parameter into a Date object.
 * Returns null if the parameter is null, empty, or invalid.
 *
 * @param param - The date string to parse (typically from searchParams.get())
 * @returns Parsed Date object or null if invalid/empty
 *
 * @example
 * ```ts
 * const startDate = parseDateParam(searchParams.get('startDate'));
 * if (startDate) {
 *   // Use the date
 * }
 * ```
 */
export function parseDateParam(param: string | null): Date | null {
  if (!param) return null;
  const date = new Date(param);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Create an enum validator function for query parameters.
 * Returns the validated value if it matches, or the default value otherwise.
 *
 * @param validValues - Array of valid values (typically a const array)
 * @param defaultValue - Value to return if input is invalid
 * @returns Validation function
 *
 * @example
 * ```ts
 * const VALID_USER_TYPES = ['all', 'real', 'actors', 'agents'] as const;
 * const validateUserType = createEnumValidator(VALID_USER_TYPES, 'all');
 * const userType = validateUserType(searchParams.get('userType'));
 * ```
 */
export function createEnumValidator<T extends readonly string[]>(
  validValues: T,
  defaultValue: T[number],
): (value: string | null) => T[number] {
  return (value: string | null): T[number] => {
    if (!value || !validValues.includes(value as T[number])) {
      return defaultValue;
    }
    return value as T[number];
  };
}

/**
 * Validate that a value is one of the allowed enum values.
 * Returns the validated value if it matches, or the default value otherwise.
 *
 * @param value - The value to validate
 * @param validValues - Array of valid values
 * @param defaultValue - Value to return if input is invalid
 * @returns The validated value or default
 *
 * @example
 * ```ts
 * const marketType = validateEnum(
 *   searchParams.get('marketType'),
 *   ['all', 'prediction', 'perpetual'] as const,
 *   'all'
 * );
 * ```
 */
export function validateEnum<T extends readonly string[]>(
  value: string | null,
  validValues: T,
  defaultValue: T[number],
): T[number] {
  if (!value || !validValues.includes(value as T[number])) {
    return defaultValue;
  }
  return value as T[number];
}

/** Maximum allowed date range in days to prevent heavy queries */
export const MAX_DATE_RANGE_DAYS = 365;

/**
 * Validate that a date range doesn't exceed the maximum allowed days.
 * Returns null if valid, or an error message if invalid.
 *
 * @param startDate - Start of the date range
 * @param endDate - End of the date range
 * @param maxDays - Maximum allowed range in days (defaults to MAX_DATE_RANGE_DAYS)
 * @returns null if valid, error message string if invalid
 *
 * @example
 * ```ts
 * const dateRangeError = validateDateRange(startDate, endDate);
 * if (dateRangeError) {
 *   return errorResponse(dateRangeError, 'INVALID_DATE_RANGE', 400);
 * }
 * ```
 */
export function validateDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
  maxDays: number = MAX_DATE_RANGE_DAYS,
): string | null {
  if (!startDate || !endDate) return null;

  const diffMs = endDate.getTime() - startDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays < 0) {
    return "startDate must be before endDate";
  }

  if (diffDays > maxDays) {
    return `Date range cannot exceed ${maxDays} days`;
  }

  return null;
}

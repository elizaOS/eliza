/**
 * Centralized validation utilities.
 * Use these for input validation at API boundaries and entry points.
 */

/**
 * UUID regex pattern for validation (versions 1-5 only).
 * Note: UUID v6/v7/v8 are not supported as they use different version digits.
 * Matches standard UUID format: xxxxxxxx-xxxx-Vxxx-Nxxx-xxxxxxxxxxxx
 * where V = version (1-5) and N = variant (8, 9, a, b)
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates that a string is a valid UUID format.
 * Use this to validate user input before database queries.
 *
 * @param value - The string to validate.
 * @returns True if the string is a valid UUID.
 *
 * @example
 * ```ts
 * const characterId = searchParams.characterId;
 * if (characterId && !isValidUUID(characterId)) {
 *   return; // Invalid UUID, skip database query
 * }
 * ```
 */
export function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Sanitizes a potential UUID string by removing invalid trailing characters.
 * Returns undefined if the result is not a valid UUID.
 *
 * Only trailing garbage is removed. UUIDs with embedded invalid characters
 * will be rejected entirely (fail-fast approach).
 *
 * Common issue: URL-encoded backslashes (%5C) decode to '\' and append to UUIDs.
 *
 * @param value - The potentially malformed UUID string.
 * @returns The sanitized UUID if valid, undefined otherwise.
 */
export function sanitizeUUID(value: string | undefined | null): string | undefined {
  if (!value) return undefined;

  // Remove URL-encoded garbage that commonly appends to UUIDs:
  // - %5C decodes to backslash (\)
  // - Trailing slashes from malformed URL paths
  // - Trailing whitespace from copy/paste errors
  const cleaned = value.trim().replace(/[\\/\s]+$/, "");

  return isValidUUID(cleaned) ? cleaned : undefined;
}

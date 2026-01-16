/**
 * Sanitizes a JSON object by replacing problematic Unicode escape sequences
 * that could cause errors during JSON serialization/storage
 *
 * @param value - The value to sanitize
 * @param seen - WeakSet to track circular references (internal use)
 * @returns The sanitized value
 */
export function sanitizeJsonObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    // Handle multiple cases that can cause PostgreSQL/PgLite JSON parsing errors:
    // 1. Remove null bytes (U+0000) which are not allowed in PostgreSQL text fields
    // 2. Escape single backslashes that might be interpreted as escape sequences
    // 3. Fix broken Unicode escape sequences (\u not followed by 4 hex digits)
    return value
      .replace(/\u0000/g, '') // Remove null bytes
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\') // Escape single backslashes not part of valid escape sequences
      .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u'); // Fix malformed Unicode escape sequences
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) {
      return null;
    } else {
      seen.add(value as object);
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonObject(item, seen));
    } else {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        // Also sanitize object keys
        const sanitizedKey =
          typeof key === 'string'
            ? key.replace(/\u0000/g, '').replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u')
            : key;
        result[sanitizedKey] = sanitizeJsonObject(val, seen);
      }
      return result;
    }
  }

  return value;
}

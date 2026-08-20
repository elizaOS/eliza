/**
 * Shared request-boundary helpers for computer-use HTTP route handlers.
 */

/** Decode one URL path segment, returning null when its encoding is malformed. */
export function decodePathComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // error-policy:J3 malformed URL encoding is invalid request input.
    return null;
  }
}

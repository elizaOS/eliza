/**
 * Shared origin validation helpers.
 *
 * These helpers normalize full URLs to origins so callers can safely compare:
 * - Browser Origin headers
 * - Referer URLs
 * - Redirect URIs
 * - Stored allowlist entries that may include paths
 */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPath(value: string): string {
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i);
  return match?.[0] ?? value;
}

/**
 * Normalize a URL-like value to just its origin.
 * Returns null when the value cannot be interpreted as an http/https origin.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Checks whether a candidate URL or origin matches one of the configured
 * allowed origins. Allowlist entries may be full URLs, origins, or wildcard
 * origins like https://*.example.com.
 */
export function isAllowedOrigin(allowedOrigins: string[], candidate: string): boolean {
  const candidateOrigin = normalizeOrigin(candidate);
  if (!candidateOrigin) {
    return false;
  }

  for (const entry of allowedOrigins) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    if (trimmed === "*") {
      return true;
    }

    if (trimmed.includes("*")) {
      const pattern = stripPath(trimmed);
      const regex = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
      if (regex.test(candidateOrigin)) {
        return true;
      }
      continue;
    }

    const normalizedAllowed = normalizeOrigin(trimmed) ?? trimmed;
    if (normalizedAllowed === candidateOrigin) {
      return true;
    }
  }

  return false;
}

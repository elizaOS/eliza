/**
 * URL normalization helpers shared across the extension: coerce a user-entered
 * agent API URL or a page origin to a canonical, safe http(s) form. Rejects
 * non-http(s) schemes and credentials-in-URL so downstream code can trust the
 * result. Pure functions with no browser dependencies.
 */
export function normalizeHttpBaseUrl(
  value: unknown,
  defaultValue: string | null = null,
): string | null {
  const trimmed =
    typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!trimmed) {
    return defaultValue;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function normalizeHttpOrigin(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

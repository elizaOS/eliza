/**
 * URL normalization helpers shared across the extension: coerce a user-entered
 * agent API URL, a page origin, or a blocked-site navigation target to a
 * canonical, safe http(s) form. Rejects non-http(s) schemes and
 * credentials-in-URL so downstream code can trust the result. Pure functions
 * with no browser dependencies.
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

/**
 * Coerce a blocked-site URL — which arrives from the block interstitial's own
 * `?url=` query param and may be scheme-less (e.g. `example.com`) — to a
 * canonical http(s) URL safe to assign to `window.location.href`. Returns null
 * for anything that does not resolve to an http/https URL, so a crafted
 * `javascript:`/`data:` value can never reach the navigation sink (a
 * `startsWith("http")` string check does not stop a `javascript:` scheme from
 * being force-prefixed, nor does it validate the URL is well-formed). Pure; no
 * browser dependencies.
 */
export function normalizeNavigableUrl(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("//")) {
    return null;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  const scheme = schemeMatch?.[1]?.toLowerCase();
  const afterSchemeColon = schemeMatch
    ? trimmed.slice(schemeMatch[0].length)
    : "";
  const hostPortLike =
    scheme !== undefined &&
    (scheme.includes(".") || scheme === "localhost") &&
    /^\d+(?:[/?#]|$)/.test(afterSchemeColon);
  if (scheme && scheme !== "http" && scheme !== "https" && !hostPortLike) {
    return null;
  }
  const candidate =
    scheme === "http" || scheme === "https" ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    // error-policy:J3 untrusted query-string input resolves to an explicit invalid navigation target.
    return null;
  }
}

export function normalizeHostForComparison(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeNavigableUrl(value);
  if (!normalized) {
    return null;
  }
  return new URL(normalized).hostname.toLowerCase();
}

export function normalizeNavigableUrlForHost(
  value: string | null | undefined,
  expectedHost: string | null | undefined,
): string | null {
  const target = normalizeNavigableUrl(value);
  const host = normalizeHostForComparison(expectedHost);
  if (!target || !host) {
    return null;
  }
  const targetHost = new URL(target).hostname.toLowerCase();
  return targetHost === host ? target : null;
}

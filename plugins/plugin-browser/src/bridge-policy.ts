/**
 * Legacy browser history expiry, focus-window, and domain policy helpers.
 */

export const MAX_BROWSER_FOCUS_WINDOW_MS = 2 * 60 * 1000;
export function browserBridgeDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — `new URL()` throws on a
    // malformed URL; null is the explicit "not a valid http(s) URL" signal
    // callers fail-closed on (no domain → no focus/policy match), never a
    // fabricated-valid domain.
    return null;
  }
}

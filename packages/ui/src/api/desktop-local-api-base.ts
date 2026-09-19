/**
 * Admits desktop agent RPC only for the backend bound by the native host.
 * Renderer connection changes do not update this binding; explicit clients and
 * selected remote profiles must use their own transport, even on another local
 * port or deployment prefix. A missing native binding falls back to HTTP.
 */
function normalizedHttpBase(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    // error-policy:J3 invalid destinations never acquire local RPC authority.
    return null;
  }
}

export function isDesktopLocalApiBaseUrl(baseUrl: string): boolean {
  if (typeof window === "undefined") return false;
  const binding = normalizedHttpBase(
    (window as { __ELIZA_DESKTOP_LOCAL_API_BASE__?: unknown })
      .__ELIZA_DESKTOP_LOCAL_API_BASE__,
  );
  return binding !== null && normalizedHttpBase(baseUrl) === binding;
}

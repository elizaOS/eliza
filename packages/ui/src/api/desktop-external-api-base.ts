/**
 * Reads the desktop-injected external API base origin from the window global and
 * validates it as an http(s) origin. Used to route the client at an external
 * agent when the desktop host points it there.
 */
function getWindowExternalApiBase(): unknown {
  if (typeof window === "undefined") return null;
  return (window as { __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: unknown })
    .__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
}

function isCloudOnlyDesktopRemoteOrigin(url: string): boolean {
  if (typeof window === "undefined") return false;
  const runtimeMode = (window as { __ELIZA_DESKTOP_RUNTIME_MODE__?: unknown })
    .__ELIZA_DESKTOP_RUNTIME_MODE__;
  if (runtimeMode !== "cloud") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1" &&
      hostname !== "[::1]"
    );
  } catch {
    // error-policy:J3 an invalid URL is never a remote desktop API base.
    return false;
  }
}

export function getDesktopExternalApiBaseOrigin(): string | null {
  const value = getWindowExternalApiBase();
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    // error-policy:J3 unparseable injected base — no external API origin is
    // trusted (fail-closed).
    return null;
  }
}

export function isDesktopExternalApiBaseUrl(url: string): boolean {
  const allowedOrigin = getDesktopExternalApiBaseOrigin();
  if (!allowedOrigin) return isCloudOnlyDesktopRemoteOrigin(url);
  try {
    return new URL(url).origin === allowedOrigin;
  } catch {
    // error-policy:J3 unparseable URL never matches the allowed origin
    // (fail-closed).
    return false;
  }
}

export function isDesktopExternalHttpApiBaseUrl(url: string): boolean {
  const allowedOrigin = getDesktopExternalApiBaseOrigin();
  if (!allowedOrigin) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.origin === allowedOrigin;
  } catch {
    // error-policy:J3 unparseable URL never matches the allowed origin
    // (fail-closed).
    return false;
  }
}

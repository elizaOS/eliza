/**
 * Authenticated fetch helper for dashboard API requests.
 *
 * Layers two auth modes onto a single call:
 *   - Cookie + CSRF (browser session): sends the `eliza_session` cookie via
 *     `credentials: "include"` and mirrors the readable `eliza_csrf` cookie
 *     into the `x-eliza-csrf` header on state-changing requests.
 *   - Bearer (machine token / self-hosted bootstrap): if `getBootConfig()`
 *     exposes an apiToken, attaches `Authorization: Bearer ...`.
 *
 * Both modes can coexist on a single request — the server picks whichever
 * one validates first. Use this in place of bare `fetch` for any call that
 * targets the dashboard API.
 */

import { getBootConfig } from "../config/boot-config";
import { hydrateAndroidLocalAgentTokenForUrl } from "../onboarding/local-agent-token";
import { androidNativeAgentTransportForUrl } from "./android-native-agent-transport";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./auth/sessions";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { iosInProcessAgentTransportForUrl } from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { defaultFetchTimeoutMs } from "./request-timeout";
import { fetchAgentTransport } from "./transport";

/**
 * Reads the current CSRF token from `document.cookie`.
 * Returns null when the cookie is absent (no active session).
 */
export function readCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export async function fetchWithCsrf(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);

  if (STATE_CHANGING_METHODS.has(method)) {
    const csrfToken = readCsrfTokenFromCookie();
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  if (!headers.has("Authorization")) {
    await hydrateAndroidLocalAgentTokenForUrl(url);
    const apiToken = getBootConfig().apiToken?.trim();
    if (apiToken) {
      headers.set("Authorization", `Bearer ${apiToken}`);
    }
  }

  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
    headers,
  };
  const transport =
    (await androidNativeAgentTransportForUrl(url)) ??
    (await iosInProcessAgentTransportForUrl(url)) ??
    desktopHttpTransportForUrl(url) ??
    nativeCloudHttpTransportForUrl(url) ??
    fetchAgentTransport;
  return transport.request(url, requestInit, {
    timeoutMs: defaultFetchTimeoutMs(url, requestInit),
  });
}

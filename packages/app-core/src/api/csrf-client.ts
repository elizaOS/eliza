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
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "./auth/sessions";

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
    const apiToken = getBootConfig().apiToken?.trim();
    if (apiToken) {
      headers.set("Authorization", `Bearer ${apiToken}`);
    }
  }

  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

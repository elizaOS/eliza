/**
 * CSRF double-submit client helpers.
 *
 * The server emits a readable (non-HttpOnly) `milady_csrf` cookie alongside
 * the HttpOnly `milady_session` cookie on every session creation. For every
 * state-changing request the SPA must mirror that cookie value into the
 * `x-milady-csrf` header so the server can compare them.
 *
 * Rules:
 *   - GET / HEAD / OPTIONS never attach the header.
 *   - All other methods (POST / PUT / DELETE / PATCH) always attach it.
 *   - `credentials: "include"` is always set so session cookies travel.
 */

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

/**
 * Wraps `fetch` with:
 *   - `credentials: "include"` so session cookies are sent.
 *   - `x-milady-csrf` header on state-changing requests.
 *
 * Call this instead of bare `fetch` for all dashboard API requests that use
 * cookie-based auth. Bearer-only machine-token requests can still use bare
 * `fetch`.
 */
export async function fetchWithCsrf(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const needsCsrf = STATE_CHANGING_METHODS.has(method);
  const csrfToken = needsCsrf ? readCsrfTokenFromCookie() : null;

  const headers = new Headers(init.headers);
  if (csrfToken) {
    headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

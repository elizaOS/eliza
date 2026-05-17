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
/**
 * Reads the current CSRF token from `document.cookie`.
 * Returns null when the cookie is absent (no active session).
 */
export declare function readCsrfTokenFromCookie(): string | null;
export declare function fetchWithCsrf(
  url: string,
  init?: RequestInit,
): Promise<Response>;
//# sourceMappingURL=csrf-client.d.ts.map

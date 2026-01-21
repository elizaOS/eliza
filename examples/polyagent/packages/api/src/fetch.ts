/// <reference path="./global.d.ts" />

/**
 * API Fetch Options
 *
 * @description Extended fetch options with authentication and retry configuration.
 * Extends standard RequestInit with Polyagent-specific options for cookie-based
 * authentication and 401 retry logic.
 *
 * With HTTP-only cookies enabled in Privy, authentication is handled via the
 * `privy-token` cookie which is automatically sent when `credentials: 'include'`
 * is set. No Authorization header is needed for browser requests.
 *
 * @see https://docs.privy.io/guide/react/configuration/cookies
 */
export interface ApiFetchOptions extends RequestInit {
  /**
   * When true (default), credentials are included to send the privy-token cookie.
   */
  auth?: boolean;
  /**
   * When true (default), automatically retry with a refreshed token if the request fails with 401.
   */
  autoRetryOn401?: boolean;
}

/**
 * Get a fresh Privy access token
 *
 * @description Retrieves a fresh Privy access token by calling Privy's getAccessToken().
 * Per Privy best practices, this function ALWAYS calls getAccessToken() on-demand
 * which automatically refreshes tokens nearing expiration. Never relies on cached
 * tokens which can become stale. Returns null in server-side environments.
 *
 * @see https://docs.privy.io/authentication/user-authentication/access-tokens
 * @returns {Promise<string | null>} Access token or null if unavailable
 * @private
 */
export async function getPrivyAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  // ALWAYS call getAccessToken() on-demand - it auto-refreshes expired tokens
  // Per Privy best practices: never rely on cached tokens, always fetch fresh
  if (window.__privyGetAccessToken) {
    const token = await window.__privyGetAccessToken();
    return token;
  }

  // No token available - user not authenticated via Privy hook
  return null;
}

/**
 * Lightweight wrapper around fetch that decorates requests with authentication
 *
 * @description Wrapper around fetch that uses Privy's HTTP-only cookie authentication.
 * With cookies enabled, the `privy-token` cookie is automatically sent by the browser
 * when `credentials: 'include'` is set. No Authorization header is needed.
 *
 * On 401 errors, triggers a token refresh via `getAccessToken()` which updates the
 * cookie, then retries the request.
 *
 * @param {RequestInfo} input - Request URL or Request object
 * @param {ApiFetchOptions} [init] - Fetch options with auth configuration
 * @param {boolean} [init.auth=true] - Whether to include credentials (default: true)
 * @param {boolean} [init.autoRetryOn401=true] - Whether to retry on 401 (default: true)
 * @returns {Promise<Response>} Fetch response
 *
 * @see https://docs.privy.io/guide/react/configuration/cookies
 *
 * @example
 * ```typescript
 * // With authentication (default) - cookie sent automatically
 * const response = await apiFetch('/api/posts');
 *
 * // Without authentication
 * const response = await apiFetch('/api/public', { auth: false });
 *
 * // Custom headers
 * const response = await apiFetch('/api/data', {
 *   headers: { 'Custom-Header': 'value' }
 * });
 * ```
 */
export async function apiFetch(input: RequestInfo, init: ApiFetchOptions = {}) {
  const { auth = true, autoRetryOn401 = true, headers, ...rest } = init;
  const finalHeaders = new Headers(headers ?? {});

  // With HTTP-only cookies enabled, authentication is handled via the privy-token cookie
  // which is automatically sent when credentials: 'include' is set.
  // No Authorization header is needed - the cookie takes precedence on the server.

  let response = await fetch(input, {
    ...rest,
    headers: finalHeaders,
    credentials: auth ? "include" : (rest.credentials ?? "same-origin"),
  });

  // If we get a 401 and auto-retry is enabled, refresh the token and retry
  // getAccessToken() updates the privy-token cookie automatically
  if (response.status === 401 && auth && autoRetryOn401) {
    // Trigger token refresh - this updates the cookie
    await getPrivyAccessToken();

    // Retry with the refreshed cookie
    response = await fetch(input, {
      ...rest,
      headers: finalHeaders,
      credentials: "include",
    });
  }

  return response;
}

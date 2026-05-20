/// <reference path="./global.d.ts" />

/**
 * API Fetch Options
 *
 * @description Extended fetch options with authentication and retry configuration.
 * Extends standard RequestInit with Feed-specific options for cookie-based
 * authentication and 401 retry logic.
 *
 * Authentication is handled via Steward JWT tokens, either through an HTTP-only
 * cookie or Bearer token in the Authorization header.
 */
export interface ApiFetchOptions extends RequestInit {
  /**
   * When true (default), credentials are included to send the auth cookie.
   */
  auth?: boolean;
  /**
   * When true (default), automatically retry with a refreshed token if the request fails with 401.
   */
  autoRetryOn401?: boolean;
}

/**
 * Get a fresh access token
 *
 * @description Retrieves a fresh Steward access token via the `__privyGetAccessToken`
 * compat shim (set by StewardAuthProvider). Always calls getAccessToken() on-demand
 * which automatically refreshes tokens nearing expiration. Returns null in
 * server-side environments.
 *
 * @returns {Promise<string | null>} Access token or null if unavailable
 * @private
 */
export async function getAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  // TODO: Phase 3 — rename window.__privyGetAccessToken to window.__getAccessToken
  // ALWAYS call getAccessToken() on-demand - it auto-refreshes expired tokens
  if (window.__privyGetAccessToken) {
    const token = await window.__privyGetAccessToken();
    return token;
  }

  // No token available - user not authenticated
  return null;
}

/**
 * @deprecated Use `getAccessToken` instead. Kept for backward compatibility.
 */
export const getPrivyAccessToken = getAccessToken;

/**
 * Lightweight wrapper around fetch that decorates requests with authentication
 *
 * @description Wrapper around fetch that uses Steward JWT cookie authentication.
 * The auth cookie is automatically sent by the browser when `credentials: 'include'`
 * is set. No Authorization header is needed.
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

  // Authentication is handled via the Steward JWT cookie which is automatically
  // sent when credentials: 'include' is set.

  let response = await fetch(input, {
    ...rest,
    headers: finalHeaders,
    credentials: auth ? "include" : (rest.credentials ?? "same-origin"),
  });

  // If we get a 401 and auto-retry is enabled, refresh the token and retry
  if (response.status === 401 && auth && autoRetryOn401) {
    // Trigger token refresh - this updates the cookie
    await getAccessToken();

    // Retry with the refreshed cookie
    response = await fetch(input, {
      ...rest,
      headers: finalHeaders,
      credentials: "include",
    });
  }

  return response;
}

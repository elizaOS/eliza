/**
 * Client-side API Fetch Utility
 *
 * Lightweight wrapper around fetch that decorates requests with authentication.
 * Uses Privy's HTTP-only cookie authentication.
 */

/**
 * API Fetch Options
 *
 * Extended fetch options with authentication and retry configuration.
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
 * Retrieves a fresh Privy access token by calling Privy's getAccessToken().
 * Per Privy best practices, this function ALWAYS calls getAccessToken() on-demand
 * which automatically refreshes tokens nearing expiration.
 *
 * @returns Access token or null if unavailable
 */
export async function getPrivyAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;

  // ALWAYS call getAccessToken() on-demand - it auto-refreshes expired tokens
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
 * Supports both HTTP-only cookie authentication (privy-token cookie) and
 * Authorization header authentication. The cookie is preferred when available,
 * but falls back to Bearer token in the Authorization header.
 *
 * On 401 errors, triggers a token refresh via `getAccessToken()` and retries
 * with the fresh token in the Authorization header.
 *
 * @param input - Request URL or Request object
 * @param init - Fetch options with auth configuration
 * @returns Fetch response
 *
 * @example
 * ```typescript
 * // With authentication (default)
 * const response = await apiFetch('/api/posts');
 *
 * // Without authentication
 * const response = await apiFetch('/api/public', { auth: false });
 * ```
 */
export async function apiFetch(
  input: RequestInfo,
  init: ApiFetchOptions = {},
): Promise<Response> {
  const { auth = true, autoRetryOn401 = true, headers, ...rest } = init;
  const finalHeaders = new Headers(headers ?? {});

  // Always try to add the Authorization header with the access token.
  // This provides a fallback when HTTP-only cookies aren't available
  // (e.g., initial login, cross-origin requests, or cookie misconfiguration).
  if (auth && !finalHeaders.has("Authorization")) {
    const token = await getPrivyAccessToken();
    if (token) {
      finalHeaders.set("Authorization", `Bearer ${token}`);
    } else if (typeof window !== "undefined") {
      // Log when we can't get a token - helps debug auth issues
      console.warn(
        "[apiFetch] No access token available for authenticated request:",
        typeof input === "string" ? input : (input as Request).url,
      );
    }
  }

  let response = await fetch(input, {
    ...rest,
    headers: finalHeaders,
    credentials: auth ? "include" : (rest.credentials ?? "same-origin"),
  });

  // If we get a 401 and auto-retry is enabled, refresh the token and retry
  if (response.status === 401 && auth && autoRetryOn401) {
    // Get a fresh token (this also refreshes the cookie if HTTP-only cookies are enabled)
    const freshToken = await getPrivyAccessToken();

    if (freshToken) {
      // Update the Authorization header with the fresh token
      finalHeaders.set("Authorization", `Bearer ${freshToken}`);

      // Retry with the refreshed token
      response = await fetch(input, {
        ...rest,
        headers: finalHeaders,
        credentials: "include",
      });
    }
  }

  return response;
}

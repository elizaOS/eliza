/**
 * Client-side API Fetch Utility
 *
 * Lightweight wrapper around fetch that decorates requests with authentication.
 * Uses Steward JWT authentication (via HTTP-only cookie or Bearer token).
 *
 * Resolves relative API paths via `apiUrl()` so the same code works for both
 * web (same-origin) and mobile (cross-origin via NEXT_PUBLIC_API_URL).
 */

import { extractErrorMessage, logger } from "@feed/shared";
import { getBrowserDevAuthSession } from "@/lib/auth/dev-auth";

import { apiUrl } from "./api-url";

/**
 * API Fetch Options
 *
 * Extended fetch options with authentication and retry configuration.
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
 * Retrieves a fresh Steward access token via the `__privyGetAccessToken` compat shim
 * (set by StewardAuthProvider). Always calls getAccessToken() on-demand which
 * automatically refreshes tokens nearing expiration.
 *
 * @returns Access token or null if unavailable
 */
export async function getAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const devSession = getBrowserDevAuthSession();
  if (devSession?.accessToken) {
    return devSession.accessToken;
  }

  // TODO: Phase 3 — rename window.__privyGetAccessToken to window.__getAccessToken
  const authWindow = window as Window & {
    __privyGetAccessToken?: () => Promise<string | null>;
  };

  // ALWAYS call getAccessToken() on-demand - it auto-refreshes expired tokens
  if (authWindow.__privyGetAccessToken) {
    try {
      const token = await authWindow.__privyGetAccessToken();
      return token;
    } catch (error) {
      logger.warn(
        "Failed to retrieve access token",
        {
          error: extractErrorMessage(error),
        },
        "apiFetch",
      );
      return null;
    }
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
    const token = await getAccessToken();
    if (token) {
      finalHeaders.set("Authorization", `Bearer ${token}`);
    } else if (typeof window !== "undefined") {
      // Check for embed token from Eliza desktop/web host
      const embedToken = (window as Window & { __feedEmbedToken?: string })
        .__feedEmbedToken;
      if (embedToken) {
        finalHeaders.set("Authorization", `Bearer ${embedToken}`);
      } else {
        logger.warn(
          "No access token available for authenticated request",
          { url: typeof input === "string" ? input : (input as Request).url },
          "apiFetch",
        );
      }
    }
  }

  // Resolve relative API paths to absolute URLs when NEXT_PUBLIC_API_URL is set
  const resolvedInput = typeof input === "string" ? apiUrl(input) : input;

  let response = await fetch(resolvedInput, {
    ...rest,
    headers: finalHeaders,
    credentials: auth ? "include" : (rest.credentials ?? "same-origin"),
  });

  // If we get a 401 and auto-retry is enabled, refresh the token and retry
  if (response.status === 401 && auth && autoRetryOn401) {
    // Get a fresh token (this also refreshes the cookie if HTTP-only cookies are enabled)
    const freshToken = await getAccessToken();

    if (freshToken) {
      // Update the Authorization header with the fresh token
      finalHeaders.set("Authorization", `Bearer ${freshToken}`);

      // Retry with the refreshed token
      response = await fetch(resolvedInput, {
        ...rest,
        headers: finalHeaders,
        credentials: "include",
      });
    }
  }

  return response;
}

/**
 * Auth token utilities for accessing the cached Steward access token.
 *
 * The token is set on the window object by the useAuth hook when the user
 * authenticates via Steward. This module provides a clean API to access it
 * without spreading `typeof window !== 'undefined' ? window.__accessToken : null`
 * throughout the codebase.
 *
 * @example
 * ```ts
 * import { getAuthToken } from '@/lib/auth';
 * import { apiUrl } from '@/utils/api-url';
 *
 * const token = getAuthToken();
 * if (!token) {
 *   // Handle unauthenticated state
 *   return;
 * }
 *
 * await fetch(apiUrl('/api/protected'), {
 *   headers: { Authorization: `Bearer ${token}` }
 * });
 * ```
 */

/**
 * Get the current cached auth token.
 *
 * This accesses the token that was set by the useAuth hook when the user
 * authenticated. The token is stored on the window object for synchronous
 * access from non-hook contexts (callbacks, stores, etc.).
 *
 * @returns The access token if available, null otherwise
 */
type WindowWithAccessToken = Window & {
  __accessToken?: string | null;
};

export function getAuthToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as WindowWithAccessToken).__accessToken ?? null;
}

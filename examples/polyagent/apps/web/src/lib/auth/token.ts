/**
 * Auth token utilities for accessing the cached Privy access token.
 *
 * The token is set on the window object by the useAuth hook when the user
 * authenticates. This module provides a clean API to access it without
 * spreading `typeof window !== 'undefined' ? window.__privyAccessToken : null`
 * throughout the codebase.
 *
 * @example
 * ```ts
 * import { getAuthToken } from '@/lib/auth';
 *
 * const token = getAuthToken();
 * if (!token) {
 *   // Handle unauthenticated state
 *   return;
 * }
 *
 * await fetch('/api/protected', {
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
export function getAuthToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.__privyAccessToken ?? null;
}

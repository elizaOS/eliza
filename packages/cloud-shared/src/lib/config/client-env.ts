/**
 * Client Environment Utilities
 *
 * Provides environment-aware configuration for client-side code.
 */

/**
 * Gets the API base URL for the current environment.
 *
 * On the server, uses NEXT_PUBLIC_API_URL or defaults to localhost.
 * On the client, uses the current window origin.
 *
 * @returns API base URL.
 */
export function getApiBaseUrl(): string {
  if (typeof window === "undefined") {
    // Server-side: use environment variable or default
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
  }
  // Client-side: use current origin
  return window.location.origin;
}

/**
 * Vercel API Utilities
 *
 * Shared constants and helpers for Vercel API interactions.
 */

export const VERCEL_API_BASE = "https://api.vercel.com";

/**
 * Build Vercel API URL with team ID if available
 */
export function buildVercelUrl(path: string, teamId?: string): string {
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (teamId) {
    url.searchParams.set("teamId", teamId);
  }
  return url.toString();
}

/**
 * Make a Vercel API request
 */
export async function vercelApiRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {},
  teamId?: string,
): Promise<T> {
  const url = buildVercelUrl(path, teamId);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: { message: response.statusText },
    }));
    throw new Error(
      error.error?.message || `Vercel API error: ${response.status}`,
    );
  }

  return response.json();
}

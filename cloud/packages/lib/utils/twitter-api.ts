/**
 * Twitter API Utilities
 *
 * Shared constants and helpers for Twitter API interactions.
 */

export const TWITTER_API_BASE = "https://api.twitter.com/2";
export const TWITTER_UPLOAD_BASE = "https://upload.twitter.com/1.1";

/**
 * Make a Twitter API request
 */
export async function twitterApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${TWITTER_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      errors?: Array<{ detail?: string; message?: string }>;
    };
    const errorMessage =
      error.errors?.[0]?.detail ||
      error.errors?.[0]?.message ||
      `Twitter API error: ${response.status}`;
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Twitter API Utilities
 *
 * Shared constants and helpers for Twitter API interactions.
 */

export const TWITTER_API_BASE = "https://api.twitter.com/2";
export const TWITTER_UPLOAD_BASE = "https://upload.twitter.com/1.1";
export const TWITTER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Twitter REST hop while preserving caller cancellation.
 *
 * A caller signal is composed with the owned deadline rather than replacing
 * it, so a never-aborted caller signal cannot disable the operation bound.
 */
function twitterFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = TWITTER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

/**
 * Make a Twitter API request
 */
export async function twitterApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${TWITTER_API_BASE}${endpoint}`;

  const response = await twitterFetch(url, {
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

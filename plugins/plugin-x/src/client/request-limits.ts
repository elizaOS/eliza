/**
 * Per-endpoint `max_results` bounds for the X API v2 reads this client sends.
 *
 * X rejects a `max_results` outside the endpoint's range with HTTP 400, so a
 * caller asking for fewer posts than the minimum must still request the
 * minimum and trim the page locally.
 *
 * - Recent search (`GET /2/tweets/search/recent`): 10–100.
 *   https://docs.x.com/x-api/posts/search-recent-posts
 * - User posts timeline (`GET /2/users/:id/tweets`): 5–100.
 *   https://docs.x.com/x-api/users/get-posts
 */
export const X_MAX_RESULTS_PER_PAGE = 100;
export const X_RECENT_SEARCH_MIN_RESULTS = 10;
export const X_USER_TWEETS_MIN_RESULTS = 5;

/**
 * The `max_results` to send for a caller limit: the full page when the caller
 * set no limit, otherwise the limit clamped into `[min, X_MAX_RESULTS_PER_PAGE]`.
 * Callers must still trim the returned page to their own limit.
 */
export function maxResultsFor(limit: number | undefined, min: number): number {
  if (limit === undefined) return X_MAX_RESULTS_PER_PAGE;
  return Math.min(Math.max(limit, min), X_MAX_RESULTS_PER_PAGE);
}

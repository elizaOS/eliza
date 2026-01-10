import type { TwitterAuth } from "./auth";

/**
 * Retrieves the current trends from the Twitter API.
 *
 * NOTE: Twitter API v2 does not currently provide a public trends endpoint.
 * The trends functionality requires access to Twitter's internal APIs which
 * are not available through the official developer API.
 *
 * @param {TwitterAuth} auth - The authentication credentials for accessing the Twitter API.
 * @returns {Promise<string[]>} An empty array as trends are not supported.
 * @throws {Error} Always throws an error indicating trends are not supported.
 */
export async function getTrends(auth: TwitterAuth): Promise<string[]> {
  throw new Error(
    "Trends functionality is not supported in Twitter API v2. " +
      "This feature requires access to internal Twitter APIs that are not publicly available.",
  );
}

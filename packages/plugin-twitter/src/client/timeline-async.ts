import type { Profile } from './profile';
import type { Tweet } from './tweets';

/**
 * Interface representing the response when fetching profiles.
 * @typedef {Object} FetchProfilesResponse
 * @property {Profile[]} profiles - An array of profiles.
 * @property {string} [next] - Optional: A string representing the next page to fetch.
 */
export interface FetchProfilesResponse {
  profiles: Profile[];
  next?: string;
}

/**
 * Function type for fetching profiles.
 *
 * @param {string} query - The search query for profiles.
 * @param {number} maxProfiles - The maximum number of profiles to retrieve.
 * @param {string | undefined} cursor - The cursor for fetching the next set of profiles.
 * @returns {Promise<FetchProfilesResponse>} - A promise that resolves to a FetchProfilesResponse object.
 */
export type FetchProfiles = (
  query: string,
  maxProfiles: number,
  cursor: string | undefined
) => Promise<FetchProfilesResponse>;

/**
 * Interface representing the response from a fetch tweets API request.
 * @typedef {Object} FetchTweetsResponse
 * @property {Tweet[]} tweets - An array of Tweet objects.
 * @property {string} [next] - Optional: a string representing the next page token.
 */
export interface FetchTweetsResponse {
  tweets: Tweet[];
  next?: string;
}

/**
 * Function to fetch tweets based on a query and maximum number of tweets.
 * @param {string} query - The search query for tweets.
 * @param {number} maxTweets - The maximum number of tweets to fetch.
 * @param {string | undefined} cursor - The cursor for pagination, if any.
 * @returns {Promise<FetchTweetsResponse>} A promise that resolves to the response containing fetched tweets.
 */
export type FetchTweets = (
  query: string,
  maxTweets: number,
  cursor: string | undefined
) => Promise<FetchTweetsResponse>;

/**
 * Asynchronously generates user profiles from a timeline based on the specified query and maximum number of profiles to fetch.
 * @param {string} query - The query string to search for profiles.
 * @param {number} maxProfiles - The maximum number of profiles to return.
 * @param {FetchProfiles} fetchFunc - The function to fetch profiles based on the query, maxProfiles, and cursor.
 * @returns {AsyncGenerator<Profile, void>} An asynchronous generator that yields profiles from the timeline.
 */
export async function* getUserTimeline(
  query: string,
  maxProfiles: number,
  fetchFunc: FetchProfiles
): AsyncGenerator<Profile, void> {
  let nProfiles = 0;
  let cursor: string | undefined = undefined;
  let consecutiveEmptyBatches = 0;
  while (nProfiles < maxProfiles) {
    const batch: FetchProfilesResponse = await fetchFunc(query, maxProfiles, cursor);

    const { profiles, next } = batch;
    cursor = next;

    if (profiles.length === 0) {
      consecutiveEmptyBatches++;
      if (consecutiveEmptyBatches > 5) break;
    } else consecutiveEmptyBatches = 0;

    for (const profile of profiles) {
      if (nProfiles < maxProfiles) yield profile;
      else break;
      nProfiles++;
    }

    if (!next) break;
  }
}

/**
 * Async generator function that fetches and yields tweets from a timeline based on
 * the provided query and maximum number of tweets to retrieve.
 * @param {string} query - The search query for retrieving tweets.
 * @param {number} maxTweets - The maximum number of tweets to retrieve.
 * @param {FetchTweets} fetchFunc - The function to fetch tweets based on the query, maxTweets, and cursor.
 * @returns {AsyncGenerator<Tweet, void>} An async generator that yields retrieved tweets.
 */
export async function* getTweetTimeline(
  query: string,
  maxTweets: number,
  fetchFunc: FetchTweets
): AsyncGenerator<Tweet, void> {
  let nTweets = 0;
  let cursor: string | undefined = undefined;
  while (nTweets < maxTweets) {
    const batch: FetchTweetsResponse = await fetchFunc(query, maxTweets, cursor);

    const { tweets, next } = batch;

    if (tweets.length === 0) {
      break;
    }

    for (const tweet of tweets) {
      if (nTweets < maxTweets) {
        cursor = next;
        yield tweet;
      } else {
        break;
      }

      nTweets++;
    }
  }
}

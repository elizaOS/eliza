import { Headers } from 'headers-polyfill';
import stringify from 'json-stable-stringify';
import { addApiFeatures, bearerToken, requestApi } from './api';
import type { TwitterAuth } from './auth';
import { type Profile, getEntityIdByScreenName } from './profile';
import { getUserTimeline } from './timeline-async';
import { type RelationshipTimeline, parseRelationshipTimeline } from './timeline-relationship';
import type { QueryProfilesResponse } from './timeline-v1';

/**
 * Function to get the following profiles of a user.
 * @param {string} userId - The ID of the user to get the following profiles for.
 * @param {number} maxProfiles - The maximum number of profiles to retrieve.
 * @param {TwitterAuth} auth - The Twitter authentication credentials.
 * @returns {AsyncGenerator<Profile, void>} An async generator that yields Profile objects.
 */
export function getFollowing(
  userId: string,
  maxProfiles: number,
  auth: TwitterAuth
): AsyncGenerator<Profile, void> {
  return getUserTimeline(userId, maxProfiles, (q, mt, c) => {
    return fetchProfileFollowing(q, mt, auth, c);
  });
}

/**
 * Get followers for a specific user.
 * @param {string} userId - The user ID for which to retrieve followers.
 * @param {number} maxProfiles - The maximum number of profiles to retrieve.
 * @param {TwitterAuth} auth - The authentication credentials for the Twitter API.
 * @returns {AsyncGenerator<Profile, void>} - An async generator that yields Profile objects representing followers.
 */
export function getFollowers(
  userId: string,
  maxProfiles: number,
  auth: TwitterAuth
): AsyncGenerator<Profile, void> {
  return getUserTimeline(userId, maxProfiles, (q, mt, c) => {
    return fetchProfileFollowers(q, mt, auth, c);
  });
}

/**
 * Fetches the profiles that a user is following.
 * @param {string} userId - The ID of the user whose following profiles are to be fetched.
 * @param {number} maxProfiles - The maximum number of profiles to fetch.
 * @param {TwitterAuth} auth - The Twitter authentication details.
 * @param {string} [cursor] - Optional cursor for pagination.
 * @returns {Promise<QueryProfilesResponse>} A Promise that resolves with the response containing profiles the user is following.
 */
export async function fetchProfileFollowing(
  userId: string,
  maxProfiles: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<QueryProfilesResponse> {
  const timeline = await getFollowingTimeline(userId, maxProfiles, auth, cursor);

  return parseRelationshipTimeline(timeline);
}

/**
 * Fetches the profile followers for a given user ID.
 *
 * @param {string} userId - The user ID for which to fetch profile followers.
 * @param {number} maxProfiles - The maximum number of profiles to fetch.
 * @param {TwitterAuth} auth - The Twitter authentication credentials.
 * @param {string} [cursor] - Optional cursor for paginating results.
 * @returns {Promise<QueryProfilesResponse>} A promise that resolves with the parsed profile followers timeline.
 */
export async function fetchProfileFollowers(
  userId: string,
  maxProfiles: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<QueryProfilesResponse> {
  const timeline = await getFollowersTimeline(userId, maxProfiles, auth, cursor);

  return parseRelationshipTimeline(timeline);
}

/**
 * Asynchronously fetches the timeline of accounts that a user is following.
 *
 * @param {string} userId - The ID of the user whose following timeline is to be retrieved.
 * @param {number} maxItems - The maximum number of items to fetch (limited to 50).
 * @param {TwitterAuth} auth - The authentication information for making the API request.
 * @param {string} [cursor] - Optional cursor to paginate the results.
 * @returns {Promise<RelationshipTimeline>} A Promise that resolves to the RelationshipTimeline object representing the following timeline.
 * @throws {Error} If the client is not logged-in for profile following.
 */
async function getFollowingTimeline(
  userId: string,
  maxItems: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<RelationshipTimeline> {
  if (!auth.isLoggedIn()) {
    throw new Error('Client is not logged-in for profile following.');
  }

  if (maxItems > 50) {
    maxItems = 50;
  }

  const variables: Record<string, any> = {
    userId,
    count: maxItems,
    includePromotedContent: false,
  };

  const features = addApiFeatures({
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_media_download_video_enabled: false,
  });

  if (cursor != null && cursor !== '') {
    variables.cursor = cursor;
  }

  const params = new URLSearchParams();
  params.set('features', stringify(features) ?? '');
  params.set('variables', stringify(variables) ?? '');

  const res = await requestApi<RelationshipTimeline>(
    `https://twitter.com/i/api/graphql/iSicc7LrzWGBgDPL0tM_TQ/Following?${params.toString()}`,
    auth
  );

  if (!res.success) {
    throw res.err;
  }

  return res.value;
}

/**
 * Retrieves the followers timeline for a specific user.
 * @param userId The ID of the user whose followers timeline will be retrieved.
 * @param maxItems The maximum number of items to retrieve (up to 50).
 * @param auth The Twitter authentication credentials.
 * @param cursor (Optional) The cursor for pagination.
 * @returns A Promise that resolves with the RelationshipTimeline object.
 * @throws Error if the client is not logged in or if the API request fails.
 */
async function getFollowersTimeline(
  userId: string,
  maxItems: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<RelationshipTimeline> {
  if (!auth.isLoggedIn()) {
    throw new Error('Client is not logged-in for profile followers.');
  }

  if (maxItems > 50) {
    maxItems = 50;
  }

  const variables: Record<string, any> = {
    userId,
    count: maxItems,
    includePromotedContent: false,
  };

  const features = addApiFeatures({
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_media_download_video_enabled: false,
  });

  if (cursor != null && cursor !== '') {
    variables.cursor = cursor;
  }

  const params = new URLSearchParams();
  params.set('features', stringify(features) ?? '');
  params.set('variables', stringify(variables) ?? '');

  const res = await requestApi<RelationshipTimeline>(
    `https://twitter.com/i/api/graphql/rRXFSG5vR6drKr5M37YOTw/Followers?${params.toString()}`,
    auth
  );

  if (!res.success) {
    throw res.err;
  }

  return res.value;
}

/**
 * Makes a request to follow a user on Twitter.
 *
 * @param {string} username - The username of the user to follow.
 * @param {TwitterAuth} auth - Twitter authentication object.
 * @returns {Promise<Response>} - A Promise that resolves with the response data.
 * @throws {Error} - If the user is not logged in, or if an error occurs during the follow process.
 */
export async function followUser(username: string, auth: TwitterAuth): Promise<Response> {
  // Check if the user is logged in
  if (!(await auth.isLoggedIn())) {
    throw new Error('Must be logged in to follow users');
  }
  // Get user ID from username
  const userIdResult = await getEntityIdByScreenName(username, auth);

  if (!userIdResult.success) {
    throw new Error(`Failed to get user ID: ${userIdResult.err.message}`);
  }

  const userId = userIdResult.value;

  // Prepare the request body
  const requestBody = {
    include_profile_interstitial_type: '1',
    skip_status: 'true',
    user_id: userId,
  };

  // Prepare the headers
  const headers = new Headers({
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: `https://twitter.com/${username}`,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Client-Language': 'en',
    Authorization: `Bearer ${bearerToken}`,
  });

  // Install auth headers
  await auth.installTo(headers, 'https://api.twitter.com/1.1/friendships/create.json');

  // Make the follow request using auth.fetch
  const res = await auth.fetch('https://api.twitter.com/1.1/friendships/create.json', {
    method: 'POST',
    headers,
    body: new URLSearchParams(requestBody).toString(),
    credentials: 'include',
  });

  if (!res.ok) {
    throw new Error(`Failed to follow user: ${res.statusText}`);
  }

  const data = await res.json();

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

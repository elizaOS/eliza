import stringify from 'json-stable-stringify';
import { addApiFeatures, requestApi } from './api';
import type { TwitterAuth } from './auth';
import type { Profile } from './profile';
import { getTweetTimeline, getUserTimeline } from './timeline-async';
import {
  type SearchTimeline,
  parseSearchTimelineTweets,
  parseSearchTimelineUsers,
} from './timeline-search';
import type { QueryProfilesResponse, QueryTweetsResponse } from './timeline-v1';
import type { Tweet } from './tweets';

/**
 * The categories that can be used in Twitter searches.
 */
/**
 * Enum representing different search modes.
 * @enum {number}
 */

export enum SearchMode {
  Top = 0,
  Latest = 1,
  Photos = 2,
  Videos = 3,
  Users = 4,
}

export function searchTweets(
  query: string,
  maxTweets: number,
  searchMode: SearchMode,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  return getTweetTimeline(query, maxTweets, (q, mt, c) => {
    return fetchSearchTweets(q, mt, searchMode, auth, c);
  });
}

export function searchProfiles(
  query: string,
  maxProfiles: number,
  auth: TwitterAuth
): AsyncGenerator<Profile, void> {
  return getUserTimeline(query, maxProfiles, (q, mt, c) => {
    return fetchSearchProfiles(q, mt, auth, c);
  });
}

export async function fetchSearchTweets(
  query: string,
  maxTweets: number,
  searchMode: SearchMode,
  auth: TwitterAuth,
  cursor?: string
): Promise<QueryTweetsResponse> {
  const timeline = await getSearchTimeline(query, maxTweets, searchMode, auth, cursor);

  return parseSearchTimelineTweets(timeline);
}

export async function fetchSearchProfiles(
  query: string,
  maxProfiles: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<QueryProfilesResponse> {
  const timeline = await getSearchTimeline(query, maxProfiles, SearchMode.Users, auth, cursor);

  return parseSearchTimelineUsers(timeline);
}

async function getSearchTimeline(
  query: string,
  maxItems: number,
  searchMode: SearchMode,
  auth: TwitterAuth,
  cursor?: string
): Promise<SearchTimeline> {
  if (!auth.isLoggedIn()) {
    throw new Error('Client is not logged-in for search.');
  }

  if (maxItems > 50) {
    maxItems = 50;
  }

  const variables: Record<string, any> = {
    rawQuery: query,
    count: maxItems,
    querySource: 'typed_query',
    product: 'Top',
  };

  const features = addApiFeatures({
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    responsive_web_media_download_video_enabled: false,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    interactive_text_enabled: false,
    responsive_web_text_conversations_enabled: false,
    vibe_api_enabled: false,
  });

  const fieldToggles: Record<string, any> = {
    withArticleRichContentState: false,
  };

  if (cursor != null && cursor !== '') {
    variables.cursor = cursor;
  }

  switch (searchMode) {
    case SearchMode.Latest:
      variables.product = 'Latest';
      break;
    case SearchMode.Photos:
      variables.product = 'Photos';
      break;
    case SearchMode.Videos:
      variables.product = 'Videos';
      break;
    case SearchMode.Users:
      variables.product = 'People';
      break;
    default:
      break;
  }

  const params = new URLSearchParams();
  params.set('features', stringify(features) ?? '');
  params.set('fieldToggles', stringify(fieldToggles) ?? '');
  params.set('variables', stringify(variables) ?? '');

  const res = await requestApi<SearchTimeline>(
    `https://api.twitter.com/graphql/gkjsKepM6gl_HmFWoWKfgg/SearchTimeline?${params.toString()}`,
    auth
  );

  if (!res.success) {
    throw (res as any).err;
  }

  return res.value;
}

/**
 * Fetches one page of tweets that quote a given tweet ID.
 * This function does not handle pagination.
 * All comments must remain in English.
 *
 * @param quotedTweetId The tweet ID you want quotes of.
 * @param maxTweets Maximum number of tweets to return in one page.
 * @param auth The TwitterAuth object.
 * @param cursor Optional pagination cursor for fetching further pages.
 * @returns A promise that resolves to a QueryTweetsResponse containing tweets and the next cursor.
 */
export async function fetchQuotedTweetsPage(
  quotedTweetId: string,
  maxTweets: number,
  auth: TwitterAuth,
  cursor?: string
): Promise<QueryTweetsResponse> {
  if (maxTweets > 50) {
    maxTweets = 50;
  }

  // Build the rawQuery and variables
  const variables: Record<string, any> = {
    rawQuery: `quoted_tweet_id:${quotedTweetId}`,
    count: maxTweets,
    querySource: 'tdqt',
    product: 'Top',
  };

  if (cursor && cursor !== '') {
    variables.cursor = cursor;
  }

  const features = addApiFeatures({
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: false,
    responsive_web_enhance_cards_enabled: false,
  });

  const fieldToggles: Record<string, any> = {
    withArticleRichContentState: false,
  };

  const params = new URLSearchParams();
  params.set('features', stringify(features) ?? '');
  params.set('fieldToggles', stringify(fieldToggles) ?? '');
  params.set('variables', stringify(variables) ?? '');

  const url = `https://x.com/i/api/graphql/1BP5aKg8NvTNvRCyyCyq8g/SearchTimeline?${params.toString()}`;

  // Perform the request
  const res = await requestApi(url, auth);
  if (!res.success) {
    throw (res as any).err;
  }

  // Force cast for TypeScript
  const timeline = res.value as any;
  // Use parseSearchTimelineTweets to convert timeline data
  return parseSearchTimelineTweets(timeline);
}

/**
 * Creates an async generator, yielding pages of quotes for a given tweet ID.
 * It prevents infinite loop by checking if the next cursor hasn't changed.
 */
export async function* searchQuotedTweets(
  quotedTweetId: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<QueryTweetsResponse> {
  let cursor: string | undefined;

  while (true) {
    const response = await fetchQuotedTweetsPage(quotedTweetId, maxTweets, auth, cursor);
    yield response;

    // Prevent infinite loop if the API keeps returning the same cursor
    if (!response.next || response.next === cursor) {
      break;
    }

    // Update cursor for the next iteration
    cursor = response.next;
  }
}

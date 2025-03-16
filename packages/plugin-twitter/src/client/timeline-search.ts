import { type Profile, parseProfile } from './profile';
import type { QueryProfilesResponse, QueryTweetsResponse } from './timeline-v1';
import { type SearchEntryRaw, parseLegacyTweet } from './timeline-v2';
import type { Tweet } from './tweets';

/**
 * Represents a search timeline object.
 * * @typedef { Object } SearchTimeline
 * @property { Object } [data] - Optional data object containing search information.
 * @property { Object } [data.search_by_raw_query] - Optional object containing search timeline information.
 * @property { Object } [data.search_by_raw_query.search_timeline] - Optional object containing search timeline details.
 * @property { Object } [data.search_by_raw_query.search_timeline.timeline] - Optional object containing timeline instructions.
 * @property {Array<Object>} [data.search_by_raw_query.search_timeline.timeline.instructions] - Optional array of search entry instructions.
 * @property {Array<SearchEntryRaw>} [data.search_by_raw_query.search_timeline.timeline.instructions.entries] - Optional array of raw search entries.
 * @property { SearchEntryRaw } [data.search_by_raw_query.search_timeline.timeline.instructions.entry] - Optional raw search entry.
 * @property { string } [data.search_by_raw_query.search_timeline.timeline.instructions.type] - Optional type of search instructions.
 */
export interface SearchTimeline {
  data?: {
    search_by_raw_query?: {
      search_timeline?: {
        timeline?: {
          instructions?: {
            entries?: SearchEntryRaw[];
            entry?: SearchEntryRaw;
            type?: string;
          }[];
        };
      };
    };
  };
}

/**
 * Parses the search timeline tweets from the provided SearchTimeline object.
 *
 * @param {SearchTimeline} timeline The SearchTimeline object containing the data to be parsed.
 * @returns {QueryTweetsResponse} An object containing an array of parsed Tweet objects, as well as the next and previous cursors for pagination.
 */
export function parseSearchTimelineTweets(timeline: SearchTimeline): QueryTweetsResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const tweets: Tweet[] = [];
  const instructions =
    timeline.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries' || instruction.type === 'TimelineReplaceEntry') {
      if (instruction.entry?.content?.cursorType === 'Bottom') {
        bottomCursor = instruction.entry.content.value;
        continue;
      }
      if (instruction.entry?.content?.cursorType === 'Top') {
        topCursor = instruction.entry.content.value;
        continue;
      }

      const entries = instruction.entries ?? [];
      for (const entry of entries) {
        const itemContent = entry.content?.itemContent;
        if (itemContent?.tweetDisplayType === 'Tweet') {
          const tweetResultRaw = itemContent.tweet_results?.result;
          const tweetResult = parseLegacyTweet(
            tweetResultRaw?.core?.user_results?.result?.legacy,
            tweetResultRaw?.legacy
          );

          if (tweetResult.success) {
            if (!tweetResult.tweet.views && tweetResultRaw?.views?.count) {
              const views = Number.parseInt(tweetResultRaw.views.count);
              if (!Number.isNaN(views)) {
                tweetResult.tweet.views = views;
              }
            }

            tweets.push(tweetResult.tweet);
          }
        } else if (entry.content?.cursorType === 'Bottom') {
          bottomCursor = entry.content.value;
        } else if (entry.content?.cursorType === 'Top') {
          topCursor = entry.content.value;
        }
      }
    }
  }

  return { tweets, next: bottomCursor, previous: topCursor };
}

/**
 * Parses the search timeline users from the provided SearchTimeline.
 * @param {SearchTimeline} timeline The search timeline to parse users from.
 * @returns {QueryProfilesResponse} An object containing the parsed profiles along with next and previous cursors.
 */
export function parseSearchTimelineUsers(timeline: SearchTimeline): QueryProfilesResponse {
  let bottomCursor: string | undefined;
  let topCursor: string | undefined;
  const profiles: Profile[] = [];
  const instructions =
    timeline.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];

  for (const instruction of instructions) {
    if (instruction.type === 'TimelineAddEntries' || instruction.type === 'TimelineReplaceEntry') {
      if (instruction.entry?.content?.cursorType === 'Bottom') {
        bottomCursor = instruction.entry.content.value;
        continue;
      }
      if (instruction.entry?.content?.cursorType === 'Top') {
        topCursor = instruction.entry.content.value;
        continue;
      }

      const entries = instruction.entries ?? [];
      for (const entry of entries) {
        const itemContent = entry.content?.itemContent;
        if (itemContent?.userDisplayType === 'User') {
          const userResultRaw = itemContent.user_results?.result;

          if (userResultRaw?.legacy) {
            const profile = parseProfile(userResultRaw.legacy, userResultRaw.is_blue_verified);

            if (!profile.userId) {
              profile.userId = userResultRaw.rest_id;
            }

            profiles.push(profile);
          }
        } else if (entry.content?.cursorType === 'Bottom') {
          bottomCursor = entry.content.value;
        } else if (entry.content?.cursorType === 'Top') {
          topCursor = entry.content.value;
        }
      }
    }
  }

  return { profiles, next: bottomCursor, previous: topCursor };
}

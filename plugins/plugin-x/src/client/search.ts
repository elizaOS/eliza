/**
 * X recent-search helpers: one-page `searchTweetsPage` (honors `next_token`)
 * and the `searchTweets` generator that walks those pages up to `maxTweets`.
 */
import { ElizaError } from "@elizaos/core";
import type { TweetV2, Tweetv2SearchParams, UserV2 } from "twitter-api-v2";
import type { QueryTweetsResponse } from "./api-types";
import type { TwitterAuth } from "./auth";
import type { Profile } from "./profile";
import type { Tweet } from "./tweets";

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

type SearchIncludes = {
  users?: UserV2[];
  tweets?: TweetV2[];
};

type SearchPaginator = {
  tweets?: TweetV2[];
  includes?: SearchIncludes;
  meta?: { next_token?: string };
};

const SEARCH_TWEET_QUERY: Partial<Tweetv2SearchParams> = {
  "tweet.fields": [
    "id",
    "text",
    "conversation_id",
    "created_at",
    "author_id",
    "referenced_tweets",
    "entities",
    "public_metrics",
    "attachments",
  ],
  "user.fields": ["id", "name", "username", "profile_image_url"],
  "media.fields": ["url", "preview_image_url", "type"],
  expansions: [
    "author_id",
    "attachments.media_keys",
    "referenced_tweets.id",
    "referenced_tweets.id.author_id",
  ],
};

function applySearchMode(query: string, searchMode: SearchMode): string {
  switch (searchMode) {
    case SearchMode.Photos:
      return `${query} has:media has:images`;
    case SearchMode.Videos:
      return `${query} has:media has:videos`;
    default:
      return query;
  }
}

function currentPageTweets(paginator: SearchPaginator): TweetV2[] {
  return Array.isArray(paginator.tweets) ? paginator.tweets : [];
}

function convertSearchTweet(tweet: TweetV2, includes?: SearchIncludes): Tweet {
  const author = includes?.users?.find((user) => user.id === tweet.author_id);
  const inReplyToStatusId = tweet.referenced_tweets?.find(
    (rt) => rt.type === "replied_to",
  )?.id;
  const inReplyToStatus = inReplyToStatusId
    ? includes?.tweets?.find(
        (includedTweet) => includedTweet.id === inReplyToStatusId,
      )
    : undefined;
  const inReplyToAuthor = inReplyToStatus?.author_id
    ? includes?.users?.find((user) => user.id === inReplyToStatus.author_id)
    : undefined;

  return {
    id: tweet.id,
    text: tweet.text || "",
    timestamp: tweet.created_at
      ? new Date(tweet.created_at).getTime()
      : Date.now(),
    timeParsed: tweet.created_at ? new Date(tweet.created_at) : new Date(),
    userId: tweet.author_id || "",
    name: author?.name || "",
    username: author?.username || "",
    conversationId: tweet.conversation_id || tweet.id,
    hashtags: tweet.entities?.hashtags?.map((h) => h.tag) || [],
    mentions:
      tweet.entities?.mentions?.map((m) => ({
        id: m.id || "",
        username: m.username || "",
        name: "",
      })) || [],
    inReplyToStatusId,
    inReplyToStatus: inReplyToStatus
      ? {
          id: inReplyToStatus.id,
          text: inReplyToStatus.text || "",
          userId: inReplyToStatus.author_id || "",
          name: inReplyToAuthor?.name || "",
          username: inReplyToAuthor?.username || "",
          hashtags: [],
          mentions: [],
          photos: [],
          thread: [],
          urls: [],
          videos: [],
        }
      : undefined,
    photos: [],
    thread: [],
    urls: tweet.entities?.urls?.map((u) => u.expanded_url || u.url) || [],
    videos: [],
    isRetweet:
      tweet.referenced_tweets?.some((rt) => rt.type === "retweeted") || false,
    isReply:
      tweet.referenced_tweets?.some((rt) => rt.type === "replied_to") || false,
    isQuoted:
      tweet.referenced_tweets?.some((rt) => rt.type === "quoted") || false,
    isPin: false,
    sensitiveContent: false,
    likes: tweet.public_metrics?.like_count || undefined,
    replies: tweet.public_metrics?.reply_count || undefined,
    retweets: tweet.public_metrics?.retweet_count || undefined,
    views: tweet.public_metrics?.impression_count || undefined,
    quotes: tweet.public_metrics?.quote_count || undefined,
  };
}

/**
 * Fetch one page of v2 recent-search results, honoring `next_token` and
 * returning the provider's next cursor so callers can resume.
 */
export async function searchTweetsPage(
  query: string,
  maxTweets: number,
  searchMode: SearchMode,
  auth: TwitterAuth,
  cursor?: string,
): Promise<QueryTweetsResponse> {
  const client = await auth.getV2Client();
  const finalQuery = applySearchMode(query, searchMode);
  const paginationToken = cursor?.trim() ? cursor.trim() : undefined;

  try {
    const paginator = (await client.v2.search(finalQuery, {
      max_results: Math.min(maxTweets, 100),
      ...SEARCH_TWEET_QUERY,
      ...(paginationToken ? { next_token: paginationToken } : {}),
    })) as SearchPaginator;

    const converted = currentPageTweets(paginator)
      .slice(0, maxTweets)
      .map((tweet) => convertSearchTweet(tweet, paginator.includes));

    return {
      tweets: converted,
      next: paginator.meta?.next_token,
    };
  } catch (error) {
    // error-policy:J2 context-adding rethrow — attach the query that faulted.
    throw new ElizaError("Tweet search failed", {
      code: "X_SEARCH_FAILED",
      cause: error,
      context: { query, searchMode },
    });
  }
}

/**
 * Search for tweets using Twitter API v2
 *
 * @param query Search query
 * @param maxTweets Maximum number of tweets to return
 * @param searchMode Search mode (not all modes are supported in v2)
 * @param auth Authentication
 * @returns Async generator of tweets
 */
export async function* searchTweets(
  query: string,
  maxTweets: number,
  searchMode: SearchMode,
  auth: TwitterAuth,
): AsyncGenerator<Tweet, void> {
  const client = await auth.getV2Client();
  const finalQuery = applySearchMode(query, searchMode);

  try {
    const searchIterator = (await client.v2.search(finalQuery, {
      max_results: Math.min(maxTweets, 100),
      ...SEARCH_TWEET_QUERY,
    })) as SearchPaginator & AsyncIterable<TweetV2>;

    let count = 0;
    for await (const tweet of searchIterator) {
      if (count >= maxTweets) break;
      yield convertSearchTweet(tweet, searchIterator.includes);
      count++;
    }
  } catch (error) {
    // error-policy:J2 context-adding rethrow — attach the query that faulted.
    throw new ElizaError("Tweet search failed", {
      code: "X_SEARCH_FAILED",
      cause: error,
      context: { query, searchMode },
    });
  }
}

/**
 * Search for users using Twitter API v2
 *
 * Note: User search is limited in the standard Twitter API v2.
 * This searches for users mentioned in tweets matching the query.
 *
 * @param query Search query
 * @param maxProfiles Maximum number of profiles to return
 * @param auth Authentication
 * @returns Async generator of profiles
 */
export async function* searchProfiles(
  query: string,
  maxProfiles: number,
  auth: TwitterAuth,
): AsyncGenerator<Profile, void> {
  const client = await auth.getV2Client();
  const userIds = new Set<string>();
  const profiles: Profile[] = [];

  try {
    // Search for tweets and extract unique user IDs
    const searchIterator = await client.v2.search(query, {
      max_results: Math.min(maxProfiles * 2, 100), // Get more tweets to find more users
      "tweet.fields": ["author_id"],
      "user.fields": [
        "id",
        "name",
        "username",
        "description",
        "profile_image_url",
        "public_metrics",
        "verified",
        "location",
        "created_at",
      ],
      expansions: ["author_id"],
    });

    for await (const tweet of searchIterator) {
      if (tweet.author_id) {
        userIds.add(tweet.author_id);
      }

      // Also get users from includes
      if (searchIterator.includes?.users) {
        for (const user of searchIterator.includes.users) {
          if (profiles.length < maxProfiles && user.id) {
            const profile: Profile = {
              userId: user.id,
              username: user.username || "",
              name: user.name || "",
              biography: user.description || "",
              avatar: user.profile_image_url || "",
              followersCount: user.public_metrics?.followers_count,
              followingCount: user.public_metrics?.following_count,
              isVerified: user.verified || false,
              location: user.location || "",
              joined: user.created_at ? new Date(user.created_at) : undefined,
            };
            profiles.push(profile);
          }
        }
      }

      if (profiles.length >= maxProfiles) break;
    }

    // Yield the profiles we found
    for (const profile of profiles) {
      yield profile;
    }
  } catch (error) {
    // error-policy:J2 context-adding rethrow — attach the query that faulted.
    throw new ElizaError("Profile search failed", {
      code: "X_PROFILE_SEARCH_FAILED",
      cause: error,
      context: { query },
    });
  }
}

/**
 * Fetch tweets quoting a specific tweet
 *
 * @param quotedTweetId The ID of the quoted tweet
 * @param maxTweets Maximum number of tweets to return
 * @param auth Authentication
 * @returns Async generator of tweets
 */
export async function* searchQuotedTweets(
  quotedTweetId: string,
  maxTweets: number,
  auth: TwitterAuth,
): AsyncGenerator<Tweet, void> {
  // Twitter API v2 doesn't have a direct endpoint for quote tweets
  // We need to search for tweets that reference this tweet
  const query = `url:"twitter.com/*/status/${quotedTweetId}"`;

  yield* searchTweets(query, maxTweets, SearchMode.Latest, auth);
}

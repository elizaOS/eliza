/**
 * `Client` — the low-level twitter-api-v2 wrapper the rest of the plugin talks to.
 * Holds a `TwitterAuth` (installed via `authenticate`/`login`) and exposes the full
 * X surface: profile/user lookups, home/user timelines, search (tweets, profiles,
 * quotes), tweet CRUD (post/note/long/quote/delete), like/retweet + inverses,
 * follows, direct messages, and retweeter/quote enumeration. Each method delegates
 * to a focused helper in `tweets.ts` / `profile.ts` / `relationships.ts` / `search.ts`
 * and unwraps the `RequestApiResult` via `handleResponse`. `ClientBase` wraps this
 * with caching and runtime-memory bookkeeping.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ElizaError, logger } from "@elizaos/core";
import type {
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
} from "twitter-api-v2";
import { normalizeXReceiptId } from "../utils/provider-receipt";
import type {
  FetchTransformOptions,
  QueryProfilesResponse,
  QueryTweetsResponse,
  RequestApiResult,
} from "./api-types";
import { TwitterAuth } from "./auth";
import type {
  TwitterAuthProvider,
  TwitterOAuth1Provider,
} from "./auth-providers/types";
import {
  getEntityIdByScreenName,
  getProfile,
  getScreenNameByUserId,
  type Profile,
} from "./profile";
import {
  fetchProfileFollowers,
  fetchProfileFollowing,
  followUser,
  getFollowers,
  getFollowing,
} from "./relationships";
import {
  SearchMode,
  searchProfiles,
  searchQuotedTweets,
  searchTweets,
} from "./search";

import {
  createCreateLongTweetRequest,
  createCreateNoteTweetRequest,
  createCreateTweetRequest,
  createCreateTweetRequestV2,
  createQuoteTweetRequest,
  defaultOptions,
  deleteTweet,
  fetchListTweets,
  getAllRetweeters,
  getLatestTweet,
  getTweet,
  getTweets,
  getTweetsAndReplies,
  getTweetsAndRepliesByUserId,
  getTweetsByUserId,
  getTweetsV2,
  getTweetsWhere,
  getTweetV2,
  getTweetWhere,
  likeTweet,
  nextTimelinePageCursor,
  type PollData,
  parseTweetV2ToV1,
  type Retweeter,
  retweet,
  type Tweet,
  type TweetQuery,
  unlikeTweet,
  unretweet,
} from "./tweets";

const _twUrl = "https://twitter.com";

/**
 * An alternative fetch function to use instead of the default fetch function. This may be useful
 * in nonstandard runtime environments, such as edge workers.
 *
 * @param {typeof fetch} fetch - The fetch function to use.
 *
 * @param {Partial<FetchTransformOptions>} transform - Additional options that control how requests
 * and responses are processed. This can be used to proxy requests through other hosts, for example.
 */
export interface ClientOptions {
  /**
   * An alternative fetch function to use instead of the default fetch function. This may be useful
   * in nonstandard runtime environments, such as edge workers.
   */
  fetch: typeof fetch;

  /**
   * Additional options that control how requests and responses are processed. This can be used to
   * proxy requests through other hosts, for example.
   */
  transform: Partial<FetchTransformOptions>;
}

type ClientAuthContext = {
  auth: TwitterAuth;
  active: boolean;
};

/**
 * An interface to Twitter's API v2.
 * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
 */
export class Client {
  private auth?: TwitterAuth;
  private readonly authContext = new AsyncLocalStorage<ClientAuthContext>();

  /**
   * Creates a new Client object.
   * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
   */
  constructor(readonly _options?: Partial<ClientOptions>) {}

  private requireAuth(): TwitterAuth {
    const context = this.authContext.getStore();
    const auth = (context?.active ? context.auth : undefined) ?? this.auth;
    if (!auth) {
      throw new Error("Not authenticated");
    }
    return auth;
  }

  /**
   * Returns the authenticated API v2 client for connector-level capabilities
   * that are not yet wrapped by this class, such as DM event polling.
   * @deprecated Raw clients cannot retain a replacement lease. Run provider
   * work inside {@link withAuthenticatedSession} instead.
   */
  public async getV2Client() {
    return this.requireAuth().getV2Client();
  }

  /**
   * Returns a point-in-time profile and API client snapshot.
   * @deprecated Use {@link withAuthenticatedSession} so the lease covers work.
   */
  public async getAuthenticatedSession() {
    return this.requireAuth().getAuthenticatedSession();
  }

  /** Keeps credential resolution pinned while an identity-sensitive operation runs. */
  public async withAuthenticatedSession<T>(
    operation: (
      session: Awaited<ReturnType<TwitterAuth["getAuthenticatedSession"]>>,
    ) => Promise<T>,
  ): Promise<T> {
    const auth = this.requireAuth();
    return auth.withAuthenticatedSession(async (session) => {
      const context: ClientAuthContext = { auth, active: true };
      try {
        return await this.authContext.run(context, () => operation(session));
      } finally {
        context.active = false;
      }
    });
  }

  private authenticatedGenerator<T>(
    operation: (auth: TwitterAuth) => AsyncIterable<T>,
  ): AsyncGenerator<T, void> {
    const client = this;
    return (async function* () {
      let iterator: AsyncIterator<T> | undefined;
      let iteratorSession:
        | Pick<
            Awaited<ReturnType<TwitterAuth["getAuthenticatedSession"]>>,
            "client" | "revision"
          >
        | undefined;
      let completed = false;

      try {
        while (true) {
          // One provider step holds one credential lease. This preserves
          // streaming and lets consumer cancellation or credential rotation
          // stop pagination between pages instead of draining the full source.
          const result = await client.withAuthenticatedSession(
            async (currentSession) => {
              if (!iterator) {
                iteratorSession = currentSession;
                iterator = operation(client.requireAuth())[
                  Symbol.asyncIterator
                ]();
              } else if (
                !iteratorSession ||
                iteratorSession.client !== currentSession.client ||
                iteratorSession.revision !== currentSession.revision
              ) {
                throw new ElizaError(
                  "X credentials rotated while an authenticated iterator was active",
                  { code: "X_AUTH_SESSION_ROTATED" },
                );
              }
              return iterator.next();
            },
          );

          if (result.done) {
            completed = true;
            return;
          }
          yield result.value;
        }
      } finally {
        if (!completed && iterator?.return) {
          await iterator.return();
        }
      }
    })();
  }

  /** Checks whether a captured session is still the active credential generation. */
  public isAuthenticatedSessionCurrent(
    session: Pick<
      Awaited<ReturnType<TwitterAuth["getAuthenticatedSession"]>>,
      "client" | "revision"
    >,
  ): boolean {
    const context = this.authContext.getStore();
    const auth = (context?.active ? context.auth : undefined) ?? this.auth;
    return auth ? auth.isAuthenticatedSessionCurrent(session) : false;
  }

  /** Publishes derived identity only while its credential generation is current. */
  public async withCurrentSession<T>(
    session: Pick<
      Awaited<ReturnType<TwitterAuth["getAuthenticatedSession"]>>,
      "client" | "revision"
    >,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.requireAuth().withCurrentSession(session, operation);
  }

  /**
   * Fetches a Twitter profile.
   * @param username The Twitter username of the profile to fetch, without an `@` at the beginning.
   * @returns The requested {@link Profile}.
   */
  public async getProfile(username: string): Promise<Profile> {
    return this.withAuthenticatedSession(async () => {
      const res = await getProfile(username, this.requireAuth());
      return this.handleResponse(res);
    });
  }

  /**
   * Fetches the user ID corresponding to the provided screen name.
   * @param screenName The Twitter screen name of the profile to fetch.
   * @returns The ID of the corresponding account.
   */
  public async getEntityIdByScreenName(screenName: string): Promise<string> {
    return this.withAuthenticatedSession(async () => {
      const res = await getEntityIdByScreenName(screenName, this.requireAuth());
      return this.handleResponse(res);
    });
  }

  /**
   *
   * @param userId The user ID of the profile to fetch.
   * @returns The screen name of the corresponding account.
   */
  public async getScreenNameByUserId(userId: string): Promise<string> {
    return this.withAuthenticatedSession(async () => {
      const response = await getScreenNameByUserId(userId, this.requireAuth());
      return this.handleResponse(response);
    });
  }

  /**
   * Fetches tweets from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxTweets The maximum number of tweets to return.
   * @param includeReplies Whether or not replies should be included in the response.
   * @param searchMode The category filter to apply to the search. Defaults to `Top`.
   * @returns An {@link AsyncGenerator} of tweets matching the provided filters.
   */
  public searchTweets(
    query: string,
    maxTweets: number,
    searchMode: SearchMode = SearchMode.Top,
  ): AsyncGenerator<Tweet, void> {
    return this.authenticatedGenerator((auth) =>
      searchTweets(query, maxTweets, searchMode, auth),
    );
  }

  /**
   * Fetches profiles from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of tweets matching the provided filter(s).
   */
  public searchProfiles(
    query: string,
    maxProfiles: number,
  ): AsyncGenerator<Profile, void> {
    return this.authenticatedGenerator((auth) =>
      searchProfiles(query, maxProfiles, auth),
    );
  }

  /**
   * Fetches tweets from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxTweets The maximum number of tweets to return.
   * @param includeReplies Whether or not replies should be included in the response.
   * @param searchMode The category filter to apply to the search. Defaults to `Top`.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public async fetchSearchTweets(
    query: string,
    maxTweets: number,
    searchMode: SearchMode,
    _cursor?: string,
  ): Promise<QueryTweetsResponse> {
    return this.withAuthenticatedSession(async () => {
      const tweets: Tweet[] = [];
      const generator = searchTweets(
        query,
        maxTweets,
        searchMode,
        this.requireAuth(),
      );

      for await (const tweet of generator) {
        tweets.push(tweet);
      }

      return {
        tweets,
        // v2 API doesn't provide cursor-based pagination for search
        next: undefined,
      };
    });
  }

  /**
   * Fetches profiles from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public async fetchSearchProfiles(
    query: string,
    maxProfiles: number,
    _cursor?: string,
  ): Promise<QueryProfilesResponse> {
    return this.withAuthenticatedSession(async () => {
      const profiles: Profile[] = [];
      const generator = searchProfiles(query, maxProfiles, this.requireAuth());

      for await (const profile of generator) {
        profiles.push(profile);
      }

      return {
        profiles,
        // v2 API doesn't provide cursor-based pagination for search
        next: undefined,
      };
    });
  }

  /**
   * Fetches list tweets from Twitter.
   * @param listId The list id
   * @param maxTweets The maximum number of tweets to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchListTweets(
    listId: string,
    maxTweets: number,
    cursor?: string,
  ): Promise<QueryTweetsResponse> {
    return this.withAuthenticatedSession(() =>
      fetchListTweets(listId, maxTweets, cursor, this.requireAuth()),
    );
  }

  /**
   * Fetch the profiles a user is following
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of following profiles for the provided user.
   */
  public getFollowing(
    userId: string,
    maxProfiles: number,
  ): AsyncGenerator<Profile, void> {
    return this.authenticatedGenerator((auth) =>
      getFollowing(userId, maxProfiles, auth),
    );
  }

  /**
   * Fetch the profiles that follow a user
   * @param userId The user whose followers should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of profiles following the provided user.
   */
  public getFollowers(
    userId: string,
    maxProfiles: number,
  ): AsyncGenerator<Profile, void> {
    return this.authenticatedGenerator((auth) =>
      getFollowers(userId, maxProfiles, auth),
    );
  }

  /**
   * Fetches following profiles from Twitter.
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchProfileFollowing(
    userId: string,
    maxProfiles: number,
    cursor?: string,
  ): Promise<QueryProfilesResponse> {
    return this.withAuthenticatedSession(() =>
      fetchProfileFollowing(userId, maxProfiles, this.requireAuth(), cursor),
    );
  }

  /**
   * Fetches profile followers from Twitter.
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchProfileFollowers(
    userId: string,
    maxProfiles: number,
    cursor?: string,
  ): Promise<QueryProfilesResponse> {
    return this.withAuthenticatedSession(() =>
      fetchProfileFollowers(userId, maxProfiles, this.requireAuth(), cursor),
    );
  }

  /**
   * Fetches the home timeline for the current user using Twitter API v2.
   * Note: Twitter API v2 doesn't distinguish between "For You" and "Following" feeds.
   * @param count The number of tweets to fetch.
   * @param seenTweetIds An array of tweet IDs that have already been seen (not used in v2).
   * @returns A promise that resolves to an array of tweets.
   */
  public async fetchHomeTimeline(
    count: number,
    _seenTweetIds: string[],
  ): Promise<Tweet[]> {
    return this.withAuthenticatedSession(async () => {
      const client = await this.requireAuth().getV2Client();

      const timeline = await client.v2.homeTimeline({
        max_results: Math.min(count, 100),
        "tweet.fields": [
          "id",
          "text",
          "created_at",
          "author_id",
          "referenced_tweets",
          "entities",
          "public_metrics",
          "attachments",
          "conversation_id",
        ],
        "user.fields": ["id", "name", "username", "profile_image_url"],
        "media.fields": ["url", "preview_image_url", "type"],
        expansions: [
          "author_id",
          "attachments.media_keys",
          "referenced_tweets.id",
        ],
      });

      const tweets: Tweet[] = [];
      for await (const tweet of timeline) {
        tweets.push(parseTweetV2ToV1(tweet, timeline.includes));
        if (tweets.length >= count) break;
      }

      return tweets;
    });
  }

  /**
   * Fetches the home timeline for the current user (same as fetchHomeTimeline in v2).
   * Twitter API v2 doesn't provide separate "Following" timeline endpoint.
   * @param count The number of tweets to fetch.
   * @param seenTweetIds An array of tweet IDs that have already been seen (not used in v2).
   * @returns A promise that resolves to an array of tweets.
   */
  public async fetchFollowingTimeline(
    count: number,
    seenTweetIds: string[],
  ): Promise<Tweet[]> {
    // In v2 API, there's no separate following timeline endpoint
    // Use the same home timeline endpoint
    return this.fetchHomeTimeline(count, seenTweetIds);
  }

  async getUserTweets(
    userId: string,
    maxTweets = 200,
    cursor?: string,
  ): Promise<{ tweets: Tweet[]; next?: string }> {
    return this.withAuthenticatedSession(async () => {
      const client = await this.requireAuth().getV2Client();

      const response = await client.v2.userTimeline(userId, {
        max_results: Math.min(maxTweets, 100),
        "tweet.fields": [
          "id",
          "text",
          "created_at",
          "author_id",
          "referenced_tweets",
          "entities",
          "public_metrics",
          "attachments",
          "conversation_id",
        ],
        "user.fields": ["id", "name", "username", "profile_image_url"],
        "media.fields": ["url", "preview_image_url", "type"],
        expansions: [
          "author_id",
          "attachments.media_keys",
          "referenced_tweets.id",
        ],
        pagination_token: cursor,
      });

      const tweets: Tweet[] = [];
      for await (const tweet of response) {
        tweets.push(parseTweetV2ToV1(tweet, response.includes));
        if (tweets.length >= maxTweets) break;
      }

      return {
        tweets,
        next: response.meta?.next_token,
      };
    });
  }

  async *getUserTweetsIterator(
    userId: string,
    maxTweets = 200,
  ): AsyncGenerator<Tweet, void> {
    const tweets = await this.withAuthenticatedSession(async () => {
      const collected: Tweet[] = [];
      let cursor: string | undefined;
      let pageCount = 0;
      const seenCursors = new Set<string>();

      while (collected.length < maxTweets) {
        pageCount += 1;
        const response = await this.getUserTweets(
          userId,
          maxTweets - collected.length,
          cursor,
        );
        collected.push(
          ...response.tweets.slice(0, maxTweets - collected.length),
        );

        if (collected.length >= maxTweets) break;

        cursor = nextTimelinePageCursor(
          "getUserTweetsIterator",
          response.next,
          seenCursors,
          pageCount,
        );
        if (!cursor) break;
      }
      return collected;
    });
    yield* tweets;
  }

  /**
   * Fetches the current trends from Twitter.
   * @returns The current list of trends.
   */
  public getTrends(): Promise<string[]> {
    // error-policy:J4 capability notice — the v2 API has no trends endpoint, so
    // an empty list is the designed answer, not a masked fetch failure.
    logger.warn("[X.Client] Trends API not available in Twitter API v2");
    return Promise.resolve([]);
  }

  /**
   * Fetches tweets from a Twitter user.
   * @param user The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweets(user: string, maxTweets = 200): AsyncGenerator<Tweet> {
    return this.authenticatedGenerator((auth) =>
      getTweets(user, maxTweets, auth),
    );
  }

  /**
   * Fetches tweets from a Twitter user using their ID.
   * @param userId The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsByUserId(
    userId: string,
    maxTweets = 200,
  ): AsyncGenerator<Tweet, void> {
    return this.authenticatedGenerator((auth) =>
      getTweetsByUserId(userId, maxTweets, auth),
    );
  }

  /**
   * Send a tweet
   * @param text The text of the tweet
   * @param tweetId The id of the tweet to reply to
   * @param mediaData Optional media data
   * @returns
   */

  /**
   * Upload media to Twitter using API v1 (v2 doesn't support media upload)
   * @param mediaData Buffer containing the media data
   * @param options Media upload options including mimeType
   * @returns The media ID string to attach to tweets
   */
  async uploadMedia(
    mediaData: Buffer,
    options: { mimeType: string },
  ): Promise<string> {
    return this.withAuthenticatedSession(async () => {
      const twitterApiClient = await this.requireAuth().getV2Client();
      return await twitterApiClient.v1.uploadMedia(mediaData, options);
    });
  }

  async sendTweet(
    text: string,
    replyToTweetId?: string,
    mediaData?: { data: Buffer; mediaType: string }[],
    hideLinkPreview?: boolean,
    mediaIds?: string[],
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error("Text is required");
    }
    if (text.toLowerCase().startsWith("error:")) {
      throw new Error(`Error sending tweet: ${text}`);
    }
    return this.withAuthenticatedSession(() =>
      createCreateTweetRequest(
        text,
        this.requireAuth(),
        replyToTweetId,
        mediaData,
        hideLinkPreview,
        mediaIds,
      ),
    );
  }

  async sendNoteTweet(
    text: string,
    replyToTweetId?: string,
    mediaData?: { data: Buffer; mediaType: string }[],
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error("Text is required");
    }
    if (text.toLowerCase().startsWith("error:")) {
      throw new Error(`Error sending note tweet: ${text}`);
    }
    return this.withAuthenticatedSession(() =>
      createCreateNoteTweetRequest(
        text,
        this.requireAuth(),
        replyToTweetId,
        mediaData,
      ),
    );
  }

  /**
   * Send a long tweet (Note Tweet)
   * @param text The text of the tweet
   * @param tweetId The id of the tweet to reply to
   * @param mediaData Optional media data
   * @returns
   */
  async sendLongTweet(
    text: string,
    replyToTweetId?: string,
    mediaData?: { data: Buffer; mediaType: string }[],
  ) {
    return this.withAuthenticatedSession(() =>
      createCreateLongTweetRequest(
        text,
        this.requireAuth(),
        replyToTweetId,
        mediaData,
      ),
    );
  }

  /**
   * Send a tweet
   * @param text The text of the tweet
   * @param tweetId The id of the tweet to reply to
   * @param options The options for the tweet
   * @returns
   */

  async sendTweetV2(
    text: string,
    replyToTweetId?: string,
    options?: {
      poll?: PollData;
    },
  ) {
    return this.withAuthenticatedSession(() =>
      createCreateTweetRequestV2(
        text,
        this.requireAuth(),
        replyToTweetId,
        options,
      ),
    );
  }

  /**
   * Fetches tweets and replies from a Twitter user.
   * @param user The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsAndReplies(
    user: string,
    maxTweets = 200,
  ): AsyncGenerator<Tweet> {
    return this.authenticatedGenerator((auth) =>
      getTweetsAndReplies(user, maxTweets, auth),
    );
  }

  /**
   * Fetches tweets and replies from a Twitter user using their ID.
   * @param userId The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsAndRepliesByUserId(
    userId: string,
    maxTweets = 200,
  ): AsyncGenerator<Tweet, void> {
    return this.authenticatedGenerator((auth) =>
      getTweetsAndRepliesByUserId(userId, maxTweets, auth),
    );
  }

  /**
   * Fetches the first tweet matching the given query.
   *
   * Example:
   * ```js
   * const timeline = client.getTweets('user', 200);
   * const retweet = await client.getTweetWhere(timeline, { isRetweet: true });
   * ```
   * @param tweets The {@link AsyncIterable} of tweets to search through.
   * @param query A query to test **all** tweets against. This may be either an
   * object of key/value pairs or a predicate. If this query is an object, all
   * key/value pairs must match a {@link Tweet} for it to be returned. If this query
   * is a predicate, it must resolve to `true` for a {@link Tweet} to be returned.
   * - All keys are optional.
   * - If specified, the key must be implemented by that of {@link Tweet}.
   */
  public getTweetWhere(
    tweets: AsyncIterable<Tweet>,
    query: TweetQuery,
  ): Promise<Tweet | null> {
    return getTweetWhere(tweets, query);
  }

  /**
   * Fetches all tweets matching the given query.
   *
   * Example:
   * ```js
   * const timeline = client.getTweets('user', 200);
   * const retweets = await client.getTweetsWhere(timeline, { isRetweet: true });
   * ```
   * @param tweets The {@link AsyncIterable} of tweets to search through.
   * @param query A query to test **all** tweets against. This may be either an
   * object of key/value pairs or a predicate. If this query is an object, all
   * key/value pairs must match a {@link Tweet} for it to be returned. If this query
   * is a predicate, it must resolve to `true` for a {@link Tweet} to be returned.
   * - All keys are optional.
   * - If specified, the key must be implemented by that of {@link Tweet}.
   */
  public getTweetsWhere(
    tweets: AsyncIterable<Tweet>,
    query: TweetQuery,
  ): Promise<Tweet[]> {
    return getTweetsWhere(tweets, query);
  }

  /**
   * Fetches the most recent tweet from a Twitter user.
   * @param user The user whose latest tweet should be returned.
   * @param includeRetweets Whether or not to include retweets. Defaults to `false`.
   * @returns The {@link Tweet} object or `null`/`undefined` if it couldn't be fetched.
   */
  public getLatestTweet(
    user: string,
    includeRetweets = false,
    max = 200,
  ): Promise<Tweet | null | undefined> {
    return this.withAuthenticatedSession(() =>
      getLatestTweet(user, includeRetweets, max, this.requireAuth()),
    );
  }

  /**
   * Fetches a single tweet.
   * @param id The ID of the tweet to fetch.
   * @returns The {@link Tweet} object, or `null` if it couldn't be fetched.
   */
  public getTweet(id: string): Promise<Tweet | null> {
    return this.withAuthenticatedSession(() =>
      getTweet(id, this.requireAuth()),
    );
  }

  /**
   * Fetches a single tweet by ID using the Twitter API v2.
   * Allows specifying optional expansions and fields for more detailed data.
   *
   * @param {string} id - The ID of the tweet to fetch.
   * @param {Object} [options] - Optional parameters to customize the tweet data.
   * @param {string[]} [options.expansions] - Array of expansions to include, e.g., 'attachments.poll_ids'.
   * @param {string[]} [options.tweetFields] - Array of tweet fields to include, e.g., 'created_at', 'public_metrics'.
   * @param {string[]} [options.pollFields] - Array of poll fields to include, if the tweet has a poll, e.g., 'options', 'end_datetime'.
   * @param {string[]} [options.mediaFields] - Array of media fields to include, if the tweet includes media, e.g., 'url', 'preview_image_url'.
   * @param {string[]} [options.userFields] - Array of user fields to include, if user information is requested, e.g., 'username', 'verified'.
   * @param {string[]} [options.placeFields] - Array of place fields to include, if the tweet includes location data, e.g., 'full_name', 'country'.
   * @returns {Promise<TweetV2 | null>} - The tweet data, including requested expansions and fields.
   */
  async getTweetV2(
    id: string,
    options: {
      expansions?: TTweetv2Expansion[];
      tweetFields?: TTweetv2TweetField[];
      pollFields?: TTweetv2PollField[];
      mediaFields?: TTweetv2MediaField[];
      userFields?: TTweetv2UserField[];
      placeFields?: TTweetv2PlaceField[];
    } = defaultOptions,
  ): Promise<Tweet | null> {
    return this.withAuthenticatedSession(() =>
      getTweetV2(id, this.requireAuth(), options),
    );
  }

  /**
   * Fetches multiple tweets by IDs using the Twitter API v2.
   * Allows specifying optional expansions and fields for more detailed data.
   *
   * @param {string[]} ids - Array of tweet IDs to fetch.
   * @param {Object} [options] - Optional parameters to customize the tweet data.
   * @param {string[]} [options.expansions] - Array of expansions to include, e.g., 'attachments.poll_ids'.
   * @param {string[]} [options.tweetFields] - Array of tweet fields to include, e.g., 'created_at', 'public_metrics'.
   * @param {string[]} [options.pollFields] - Array of poll fields to include, if tweets contain polls, e.g., 'options', 'end_datetime'.
   * @param {string[]} [options.mediaFields] - Array of media fields to include, if tweets contain media, e.g., 'url', 'preview_image_url'.
   * @param {string[]} [options.userFields] - Array of user fields to include, if user information is requested, e.g., 'username', 'verified'.
   * @param {string[]} [options.placeFields] - Array of place fields to include, if tweets contain location data, e.g., 'full_name', 'country'.
   * @returns {Promise<TweetV2[]> } - Array of tweet data, including requested expansions and fields.
   */
  async getTweetsV2(
    ids: string[],
    options: {
      expansions?: TTweetv2Expansion[];
      tweetFields?: TTweetv2TweetField[];
      pollFields?: TTweetv2PollField[];
      mediaFields?: TTweetv2MediaField[];
      userFields?: TTweetv2UserField[];
      placeFields?: TTweetv2PlaceField[];
    } = defaultOptions,
  ): Promise<Tweet[]> {
    return this.withAuthenticatedSession(() =>
      getTweetsV2(ids, this.requireAuth(), options),
    );
  }

  /**
   * Updates the authentication state for the client.
   * @param auth The new authentication.
   */
  public updateAuth(auth: TwitterAuth) {
    if (this.auth === auth) return;
    if (this.authContext.getStore()?.active) {
      throw new ElizaError(
        "Cannot replace X credentials inside an authenticated operation",
        { code: "X_AUTH_REPLACEMENT_DURING_SESSION" },
      );
    }
    const priorLogout = this.auth?.logout() ?? Promise.resolve();
    auth.deferUntil(priorLogout);
    this.auth = auth;
  }

  public async authenticate(provider: TwitterAuthProvider): Promise<void> {
    const auth = new TwitterAuth(provider);
    this.updateAuth(auth);
    try {
      await auth.getAuthenticatedSession();
    } catch (error) {
      // error-policy:J1 failed public authentication leaves no unusable auth
      // installed and preserves the sanitized connector error for the caller.
      if (this.auth === auth) {
        this.auth = undefined;
      }
      await auth.logout();
      throw error;
    }
  }

  /**
   * Get current authentication credentials
   * @returns {TwitterAuth | null} Current authentication or null if not authenticated
   * @deprecated Use {@link isAuthenticated} for state or
   * {@link withAuthenticatedSession} for credential-bound work.
   */
  public getAuth(): TwitterAuth | null {
    return this.auth ?? null;
  }

  /**
   * Check if client is properly authenticated with Twitter API v2 credentials
   * @returns {boolean} True if authenticated
   */
  public isAuthenticated(): boolean {
    if (!this.auth) return false;
    return this.auth.hasToken();
  }

  /**
   * Returns if the client is logged in as a real user.
   * @returns `true` if the client is logged in with a real user account; otherwise `false`.
   */
  public async isLoggedIn(): Promise<boolean> {
    return await this.requireAuth().isLoggedIn();
  }

  /**
   * Returns the currently logged in user
   * @returns The currently logged in user
   */
  public async me(): Promise<Profile | undefined> {
    return this.requireAuth().me();
  }

  /**
   * Login to Twitter using API v2 credentials only.
   * @param appKey The API key
   * @param appSecret The API secret key
   * @param accessToken The access token
   * @param accessSecret The access token secret
   */
  public async login(
    _username: string,
    _password: string,
    _email?: string,
    _twoFactorSecret?: string,
    appKey?: string,
    appSecret?: string,
    accessToken?: string,
    accessSecret?: string,
  ): Promise<void> {
    // Only use API credentials for v2 authentication
    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      throw new Error(
        "Twitter API v2 credentials are required for authentication",
      );
    }

    const resolvedAppKey = appKey;
    const resolvedAppSecret = appSecret;
    const resolvedAccessToken = accessToken;
    const resolvedAccessSecret = accessSecret;

    const provider: TwitterOAuth1Provider = {
      mode: "env",
      getAccessToken: async () => resolvedAccessToken,
      getOAuth1Credentials: async () => ({
        appKey: resolvedAppKey,
        appSecret: resolvedAppSecret,
        accessToken: resolvedAccessToken,
        accessSecret: resolvedAccessSecret,
      }),
    };
    this.updateAuth(new TwitterAuth(provider));
  }

  /** Invalidates the local authenticated client and all derived identity. */
  public async logout(): Promise<void> {
    if (this.authContext.getStore()?.active) {
      throw new ElizaError(
        "Cannot log out X credentials inside an authenticated operation",
        { code: "X_AUTH_REPLACEMENT_DURING_SESSION" },
      );
    }
    const auth = this.auth;
    this.auth = undefined;
    await auth?.logout();
  }

  /**
   * Sends a quote tweet.
   * @param text The text of the tweet.
   * @param quotedTweetId The ID of the tweet to quote.
   * @param options Optional uploaded media identifiers.
   * @returns The response from the Twitter API.
   */
  public async sendQuoteTweet(
    text: string,
    quotedTweetId: string,
    options?: {
      mediaData?: { data: Buffer; mediaType: string }[];
      mediaIds?: string[];
    },
  ) {
    return this.withAuthenticatedSession(() =>
      createQuoteTweetRequest(
        text,
        quotedTweetId,
        this.requireAuth(),
        options?.mediaData,
        options?.mediaIds,
      ),
    );
  }

  /**
   * Delete a tweet with the given ID.
   * @param tweetId The ID of the tweet to delete.
   * @returns A promise that resolves when the tweet is deleted.
   */
  public async deleteTweet(
    tweetId: string,
  ): Promise<Awaited<ReturnType<typeof deleteTweet>>> {
    return this.withAuthenticatedSession(() =>
      deleteTweet(tweetId, this.requireAuth()),
    );
  }

  /**
   * Likes a tweet with the given tweet ID.
   * @param tweetId The ID of the tweet to like.
   * @returns A promise that resolves when the tweet is liked.
   */
  public async likeTweet(tweetId: string): Promise<void> {
    await this.withAuthenticatedSession(() =>
      likeTweet(tweetId, this.requireAuth()),
    );
  }

  /**
   * Unlikes a tweet with the given tweet ID.
   * @param tweetId The ID of the tweet to unlike.
   * @returns A promise that resolves when the tweet is unliked.
   */
  public async unlikeTweet(tweetId: string): Promise<void> {
    await this.withAuthenticatedSession(() =>
      unlikeTweet(tweetId, this.requireAuth()),
    );
  }

  /**
   * Retweets a tweet with the given tweet ID.
   * @param tweetId The ID of the tweet to retweet.
   * @returns A promise that resolves when the tweet is retweeted.
   */
  public async retweet(tweetId: string): Promise<void> {
    await this.withAuthenticatedSession(() =>
      retweet(tweetId, this.requireAuth()),
    );
  }

  /**
   * Removes the authenticated user's retweet for the given tweet ID.
   * @param tweetId The ID of the tweet to unretweet.
   * @returns A promise that resolves when the tweet is unretweeted.
   */
  public async unretweet(tweetId: string): Promise<void> {
    await this.withAuthenticatedSession(() =>
      unretweet(tweetId, this.requireAuth()),
    );
  }

  /**
   * Follows a user with the given user ID.
   * @param userId The user ID of the user to follow.
   * @returns A promise that resolves when the user is followed.
   */
  public async followUser(userName: string): Promise<void> {
    await this.withAuthenticatedSession(() =>
      followUser(userName, this.requireAuth()),
    );
  }

  /**
   * Fetches direct message conversations
   * Note: This functionality requires direct message permissions on the authenticated app.
   * @param userId User ID
   * @param cursor Pagination cursor
   * @returns Array of DM conversations
   */
  public async getDirectMessageConversations(userId: string, cursor?: string) {
    return this.withAuthenticatedSession(async () => {
      const client = await this.requireAuth().getV2Client();
      const options: NonNullable<Parameters<typeof client.v2.listDmEvents>[0]> =
        {
          "dm_event.fields": [
            "id",
            "text",
            "event_type",
            "created_at",
            "sender_id",
            "dm_conversation_id",
            "participant_ids",
          ],
          event_types: ["MessageCreate"],
          ...(cursor ? { pagination_token: cursor } : {}),
        };

      const timeline = userId
        ? await client.v2.listDmEventsWithParticipant(userId, options)
        : await client.v2.listDmEvents(options);

      return { conversations: timeline.events ?? [] };
    });
  }

  /**
   * Sends a direct message to a user.
   * Note: This functionality requires direct message permissions on the authenticated app.
   * @param conversationId The ID of the conversation
   * @param text The text of the message
   * @returns The response from the Twitter API
   */
  public async sendDirectMessage(conversationId: string, text: string) {
    return this.withAuthenticatedSession(async () => {
      const client = await this.requireAuth().getV2Client();
      const data = await client.v2.sendDmInConversation(conversationId, {
        text,
      });

      return { id: normalizeXReceiptId(data.dm_event_id), data };
    });
  }

  private handleResponse<T>(res: RequestApiResult<T>): T {
    if (!res.success) {
      throw res.err;
    }

    return res.value;
  }

  /**
   * Retrieves all users who retweeted the given tweet.
   * @param tweetId The ID of the tweet.
   * @returns An array of users (retweeters).
   */
  public async getRetweetersOfTweet(tweetId: string): Promise<Retweeter[]> {
    return this.withAuthenticatedSession(() =>
      getAllRetweeters(tweetId, this.requireAuth()),
    );
  }

  /**
   * Fetches all quoted tweets for a given tweet ID, handling pagination automatically.
   * @param tweetId The ID of the tweet to fetch quotes for.
   * @param maxQuotes Maximum number of quotes to return (default: 100).
   * @returns An array of all quoted tweets.
   */
  public async fetchAllQuotedTweets(
    tweetId: string,
    maxQuotes: number = 100,
  ): Promise<Tweet[]> {
    return this.withAuthenticatedSession(async () => {
      const allQuotes: Tweet[] = [];
      let cursor: string | undefined;
      let totalFetched = 0;

      while (totalFetched < maxQuotes) {
        const batchSize = Math.min(40, maxQuotes - totalFetched);
        const page = await this.fetchQuotedTweetsPage(
          tweetId,
          batchSize,
          cursor,
        );

        if (page.tweets.length === 0) {
          break;
        }

        allQuotes.push(...page.tweets);
        totalFetched += page.tweets.length;

        if (!page.next) {
          break;
        }

        cursor = page.next;
      }

      return allQuotes.slice(0, maxQuotes);
    });
  }

  /**
   * Fetches quoted tweets for a given tweet ID.
   * This method collects quoted tweets from the generator-backed search API.
   * @param tweetId The ID of the tweet to fetch quotes for.
   * @param maxQuotes Maximum number of quotes to return.
   * @param cursor Optional cursor for pagination.
   * @returns A promise that resolves to a QueryTweetsResponse containing tweets and the next cursor.
   */
  public async fetchQuotedTweetsPage(
    tweetId: string,
    maxQuotes: number = 40,
    _cursor?: string,
  ): Promise<QueryTweetsResponse> {
    return this.withAuthenticatedSession(async () => {
      const quotes: Tweet[] = [];
      let count = 0;

      for await (const quote of searchQuotedTweets(
        tweetId,
        maxQuotes,
        this.requireAuth(),
      )) {
        quotes.push(quote);
        count++;
        if (count >= maxQuotes) break;
      }

      return {
        tweets: quotes,
        // Twitter API v2 doesn't provide a cursor for quote search.
        next: undefined,
      };
    });
  }
}

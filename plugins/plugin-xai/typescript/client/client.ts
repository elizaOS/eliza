import type {
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
} from "twitter-api-v2";

// Type aliases for X naming convention
type TPostv2Expansion = TTweetv2Expansion;
type TPostv2MediaField = TTweetv2MediaField;
type TPostv2PlaceField = TTweetv2PlaceField;
type TPostv2PollField = TTweetv2PollField;
type TPostv2PostField = TTweetv2TweetField;
type TPostv2UserField = TTweetv2UserField;

import type { FetchTransformOptions, RequestApiResult } from "./api-types";
import { XAuth } from "./auth";
import type { XAuthProvider, XOAuth1Provider } from "./auth-providers/types";
import {
  createCreateLongPostRequest,
  createCreateNotePostRequest,
  createCreatePostRequest,
  createCreatePostRequestV2,
  createQuotePostRequest,
  defaultOptions,
  deletePost,
  fetchListPosts,
  getAllReposters,
  getLatestPost,
  getPost,
  getPosts,
  getPostsAndReplies,
  getPostsAndRepliesByUserId,
  getPostsByUserId,
  getPostsV2,
  getPostsWhere,
  getPostV2,
  getPostWhere,
  likePost,
  type PollData,
  type Post,
  type PostQuery,
  parsePostV2ToV1,
  type Reposter,
  repost,
  unlikePost,
  unrepost,
} from "./posts";
// Removed messages imports - using X API v2 instead
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
import { SearchMode, searchPosts, searchProfiles, searchQuotedPosts } from "./search";
import type { QueryPostsResponse, QueryProfilesResponse } from "./types";

const _xUrl = "https://x.com";

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

/**
 * An interface to X's API v2.
 * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
 */
export class Client {
  private auth?: XAuth;

  /**
   * Creates a new Client object.
   * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
   */
  constructor(readonly _options?: Partial<ClientOptions>) {}

  /**
   * Fetches an X profile.
   * @param username The X username of the profile to fetch, without an `@` at the beginning.
   * @returns The requested {@link Profile}.
   */
  public async getProfile(username: string): Promise<Profile> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    const res = await getProfile(username, this.auth);
    return this.handleResponse(res);
  }

  /**
   * Fetches the user ID corresponding to the provided screen name.
   * @param screenName The X screen name of the profile to fetch.
   * @returns The ID of the corresponding account.
   */
  public async getEntityIdByScreenName(screenName: string): Promise<string> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    const res = await getEntityIdByScreenName(screenName, this.auth);
    return this.handleResponse(res);
  }

  /**
   *
   * @param userId The user ID of the profile to fetch.
   * @returns The screen name of the corresponding account.
   */
  public async getScreenNameByUserId(userId: string): Promise<string> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    const response = await getScreenNameByUserId(userId, this.auth);
    return this.handleResponse(response);
  }

  /**
   * Fetches posts from X.
   * @param query The search query. Any X-compatible query format can be used.
   * @param maxPosts The maximum number of posts to return.
   * @param includeReplies Whether or not replies should be included in the response.
   * @param searchMode The category filter to apply to the search. Defaults to `Top`.
   * @returns An {@link AsyncGenerator} of posts matching the provided filters.
   */
  public searchPosts(
    query: string,
    maxPosts: number,
    searchMode: SearchMode = SearchMode.Top
  ): AsyncGenerator<Post, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return searchPosts(query, maxPosts, searchMode, this.auth);
  }

  /**
   * Fetches profiles from X.
   * @param query The search query. Any X-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of profiles matching the provided filter(s).
   */
  public searchProfiles(query: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return searchProfiles(query, maxProfiles, this.auth);
  }

  /**
   * Fetches posts from X.
   * @param query The search query. Any X-compatible query format can be used.
   * @param maxPosts The maximum number of posts to return.
   * @param includeReplies Whether or not replies should be included in the response.
   * @param searchMode The category filter to apply to the search. Defaults to `Top`.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public async fetchSearchPosts(
    query: string,
    maxPosts: number,
    searchMode: SearchMode,
    _cursor?: string
  ): Promise<QueryPostsResponse> {
    // Use the generator and collect results
    const posts: Post[] = [];
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    const generator = searchPosts(query, maxPosts, searchMode, this.auth);

    for await (const post of generator) {
      posts.push(post);
    }

    return {
      posts,
      // v2 API doesn't provide cursor-based pagination for search
      next: undefined,
    };
  }

  /**
   * Fetches profiles from X.
   * @param query The search query. Any X-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public async fetchSearchProfiles(
    query: string,
    maxProfiles: number,
    _cursor?: string
  ): Promise<QueryProfilesResponse> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    // Use the generator and collect results
    const profiles: Profile[] = [];
    const generator = searchProfiles(query, maxProfiles, this.auth);

    for await (const profile of generator) {
      profiles.push(profile);
    }

    return {
      profiles,
      // v2 API doesn't provide cursor-based pagination for search
      next: undefined,
    };
  }

  /**
   * Fetches list posts from X.
   * @param listId The list id
   * @param maxPosts The maximum number of posts to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchListPosts(
    listId: string,
    maxPosts: number,
    cursor?: string
  ): Promise<QueryPostsResponse> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return fetchListPosts(listId, maxPosts, cursor, this.auth);
  }

  /**
   * Fetch the profiles a user is following
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of following profiles for the provided user.
   */
  public getFollowing(userId: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getFollowing(userId, maxProfiles, this.auth);
  }

  /**
   * Fetch the profiles that follow a user
   * @param userId The user whose followers should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of profiles following the provided user.
   */
  public getFollowers(userId: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getFollowers(userId, maxProfiles, this.auth);
  }

  /**
   * Fetches following profiles from X.
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchProfileFollowing(
    userId: string,
    maxProfiles: number,
    cursor?: string
  ): Promise<QueryProfilesResponse> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return fetchProfileFollowing(userId, maxProfiles, this.auth, cursor);
  }

  /**
   * Fetches profile followers from X.
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchProfileFollowers(
    userId: string,
    maxProfiles: number,
    cursor?: string
  ): Promise<QueryProfilesResponse> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return fetchProfileFollowers(userId, maxProfiles, this.auth, cursor);
  }

  /**
   * Fetches the home timeline for the current user using X API v2.
   * X API v2 returns a combined feed (no separate "For You" vs "Following").
   * @param count The number of posts to fetch.
   * @param seenPostIds An array of post IDs that have already been seen (not used in v2).
   * @returns A promise that resolves to an array of posts.
   */
  public async fetchHomeTimeline(count: number, _seenPostIds: string[]): Promise<Post[]> {
    if (!this.auth) {
      throw new Error("Not authenticated");
    }

    const client = await this.auth.getV2Client();

    try {
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
        expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      });

      const posts: Post[] = [];
      for await (const post of timeline) {
        posts.push(parsePostV2ToV1(post, timeline.includes));
        if (posts.length >= count) break;
      }

      return posts;
    } catch (error) {
      console.error("Failed to fetch home timeline:", error);
      throw error;
    }
  }

  /**
   * Fetches the home timeline for the current user (same as fetchHomeTimeline in v2).
   * X API v2 doesn't provide separate "Following" timeline endpoint.
   * @param count The number of posts to fetch.
   * @param seenPostIds An array of post IDs that have already been seen (not used in v2).
   * @returns A promise that resolves to an array of posts.
   */
  public async fetchFollowingTimeline(count: number, seenPostIds: string[]): Promise<Post[]> {
    // In v2 API, there's no separate following timeline endpoint
    // Use the same home timeline endpoint
    return this.fetchHomeTimeline(count, seenPostIds);
  }

  async getUserPosts(
    userId: string,
    maxPosts = 200,
    cursor?: string
  ): Promise<{ posts: Post[]; next?: string }> {
    if (!this.auth) {
      throw new Error("Not authenticated");
    }

    const client = await this.auth.getV2Client();

    try {
      const response = await client.v2.userTimeline(userId, {
        max_results: Math.min(maxPosts, 100),
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
        expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
        pagination_token: cursor,
      });

      const posts: Post[] = [];
      for await (const post of response) {
        posts.push(parsePostV2ToV1(post, response.includes));
        if (posts.length >= maxPosts) break;
      }

      return {
        posts,
        next: response.meta?.next_token,
      };
    } catch (error) {
      console.error("Failed to fetch user posts:", error);
      throw error;
    }
  }

  async *getUserPostsIterator(userId: string, maxPosts = 200): AsyncGenerator<Post, void> {
    let cursor: string | undefined;
    let retrievedPosts = 0;

    while (retrievedPosts < maxPosts) {
      const response = await this.getUserPosts(userId, maxPosts - retrievedPosts, cursor);

      for (const post of response.posts) {
        yield post;
        retrievedPosts++;
        if (retrievedPosts >= maxPosts) {
          break;
        }
      }

      cursor = response.next;

      if (!cursor) {
        break;
      }
    }
  }

  /**
   * Fetches the current trends from X.
   * @returns The current list of trends.
   */
  public getTrends(): Promise<string[]> {
    // Trends API not available in X API v2 with current implementation
    console.warn("Trends API not available in X API v2");
    return Promise.resolve([]);
  }

  /**
   * Fetches posts from an X user.
   * @param user The user whose posts should be returned.
   * @param maxPosts The maximum number of posts to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of posts from the provided user.
   */
  public getPosts(user: string, maxPosts = 200): AsyncGenerator<Post> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getPosts(user, maxPosts, this.auth);
  }

  /**
   * Fetches posts from an X user using their ID.
   * @param userId The user whose posts should be returned.
   * @param maxPosts The maximum number of posts to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of posts from the provided user.
   */
  public getPostsByUserId(userId: string, maxPosts = 200): AsyncGenerator<Post, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getPostsByUserId(userId, maxPosts, this.auth);
  }

  /**
   * Send a post
   * @param text The text of the post
   * @param postId The id of the post to reply to
   * @param mediaData Optional media data
   * @returns
   */

  async sendPost(
    text: string,
    replyToPostId?: string,
    mediaData?: { data: Buffer; mediaType: string }[],
    hideLinkPreview?: boolean
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error("Text is required");
    }
    if (text.toLowerCase().startsWith("error:")) {
      throw new Error(`Error sending post: ${text}`);
    }
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await createCreatePostRequest(
      text,
      this.auth,
      replyToPostId,
      mediaData,
      hideLinkPreview
    );
  }

  async sendNotePost(
    text: string,
    replyToPostId?: string,
    mediaData?: { data: Buffer; mediaType: string }[]
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error("Text is required");
    }
    if (text.toLowerCase().startsWith("error:")) {
      throw new Error(`Error sending note post: ${text}`);
    }
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await createCreateNotePostRequest(text, this.auth, replyToPostId, mediaData);
  }

  /**
   * Send a long post (Note Post)
   * @param text The text of the post
   * @param postId The id of the post to reply to
   * @param mediaData Optional media data
   * @returns
   */
  async sendLongPost(
    text: string,
    replyToPostId?: string,
    mediaData?: { data: Buffer; mediaType: string }[]
  ) {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await createCreateLongPostRequest(text, this.auth, replyToPostId, mediaData);
  }

  /**
   * Send a post
   * @param text The text of the post
   * @param postId The id of the post to reply to
   * @param options The options for the post
   * @returns
   */

  async sendPostV2(
    text: string,
    replyToPostId?: string,
    options?: {
      poll?: PollData;
    }
  ) {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await createCreatePostRequestV2(text, this.auth, replyToPostId, options);
  }

  /**
   * Fetches posts and replies from an X user.
   * @param user The user whose posts should be returned.
   * @param maxPosts The maximum number of posts to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of posts from the provided user.
   */
  public getPostsAndReplies(user: string, maxPosts = 200): AsyncGenerator<Post> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getPostsAndReplies(user, maxPosts, this.auth);
  }

  /**
   * Fetches posts and replies from an X user using their ID.
   * @param userId The user whose posts should be returned.
   * @param maxPosts The maximum number of posts to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of posts from the provided user.
   */
  public getPostsAndRepliesByUserId(userId: string, maxPosts = 200): AsyncGenerator<Post, void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getPostsAndRepliesByUserId(userId, maxPosts, this.auth);
  }

  /**
   * Fetches the first post matching the given query.
   *
   * Example:
   * ```js
   * const timeline = client.getPosts('user', 200);
   * const repost = await client.getPostWhere(timeline, { isRepost: true });
   * ```
   * @param posts The {@link AsyncIterable} of posts to search through.
   * @param query A query to test **all** posts against. This may be either an
   * object of key/value pairs or a predicate. If this query is an object, all
   * key/value pairs must match a {@link Post} for it to be returned. If this query
   * is a predicate, it must resolve to `true` for a {@link Post} to be returned.
   * - All keys are optional.
   * - If specified, the key must be implemented by that of {@link Post}.
   */
  public getPostWhere(posts: AsyncIterable<Post>, query: PostQuery): Promise<Post | null> {
    return getPostWhere(posts, query);
  }

  /**
   * Fetches all posts matching the given query.
   *
   * Example:
   * ```js
   * const timeline = client.getPosts('user', 200);
   * const reposts = await client.getPostsWhere(timeline, { isRepost: true });
   * ```
   * @param posts The {@link AsyncIterable} of posts to search through.
   * @param query A query to test **all** posts against. This may be either an
   * object of key/value pairs or a predicate. If this query is an object, all
   * key/value pairs must match a {@link Post} for it to be returned. If this query
   * is a predicate, it must resolve to `true` for a {@link Post} to be returned.
   * - All keys are optional.
   * - If specified, the key must be implemented by that of {@link Post}.
   */
  public getPostsWhere(posts: AsyncIterable<Post>, query: PostQuery): Promise<Post[]> {
    return getPostsWhere(posts, query);
  }

  /**
   * Fetches the most recent post from an X user.
   * @param user The user whose latest post should be returned.
   * @param includeReposts Whether or not to include reposts. Defaults to `false`.
   * @returns The {@link Post} object or `null`/`undefined` if it couldn't be fetched.
   */
  public getLatestPost(
    user: string,
    includeReposts = false,
    max = 200
  ): Promise<Post | null | undefined> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getLatestPost(user, includeReposts, max, this.auth);
  }

  /**
   * Fetches a single post.
   * @param id The ID of the post to fetch.
   * @returns The {@link Post} object, or `null` if it couldn't be fetched.
   */
  public getPost(id: string): Promise<Post | null> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return getPost(id, this.auth);
  }

  /**
   * Fetches a single post by ID using the X API v2.
   * Allows specifying optional expansions and fields for more detailed data.
   *
   * @param {string} id - The ID of the post to fetch.
   * @param {Object} [options] - Optional parameters to customize the post data.
   * @param {string[]} [options.expansions] - Array of expansions to include, e.g., 'attachments.poll_ids'.
   * @param {string[]} [options.postFields] - Array of post fields to include, e.g., 'created_at', 'public_metrics'.
   * @param {string[]} [options.pollFields] - Array of poll fields to include, if the post has a poll, e.g., 'options', 'end_datetime'.
   * @param {string[]} [options.mediaFields] - Array of media fields to include, if the post includes media, e.g., 'url', 'preview_image_url'.
   * @param {string[]} [options.userFields] - Array of user fields to include, if user information is requested, e.g., 'username', 'verified'.
   * @param {string[]} [options.placeFields] - Array of place fields to include, if the post includes location data, e.g., 'full_name', 'country'.
   * @returns {Promise<PostV2 | null>} - The post data, including requested expansions and fields.
   */
  async getPostV2(
    id: string,
    options: {
      expansions?: TPostv2Expansion[];
      postFields?: TPostv2PostField[];
      pollFields?: TPostv2PollField[];
      mediaFields?: TPostv2MediaField[];
      userFields?: TPostv2UserField[];
      placeFields?: TPostv2PlaceField[];
    } = defaultOptions
  ): Promise<Post | null> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await getPostV2(id, this.auth, options);
  }

  /**
   * Fetches multiple posts by IDs using the X API v2.
   * Allows specifying optional expansions and fields for more detailed data.
   *
   * @param {string[]} ids - Array of post IDs to fetch.
   * @param {Object} [options] - Optional parameters to customize the post data.
   * @param {string[]} [options.expansions] - Array of expansions to include, e.g., 'attachments.poll_ids'.
   * @param {string[]} [options.postFields] - Array of post fields to include, e.g., 'created_at', 'public_metrics'.
   * @param {string[]} [options.pollFields] - Array of poll fields to include, if posts contain polls, e.g., 'options', 'end_datetime'.
   * @param {string[]} [options.mediaFields] - Array of media fields to include, if posts contain media, e.g., 'url', 'preview_image_url'.
   * @param {string[]} [options.userFields] - Array of user fields to include, if user information is requested, e.g., 'username', 'verified'.
   * @param {string[]} [options.placeFields] - Array of place fields to include, if posts contain location data, e.g., 'full_name', 'country'.
   * @returns {Promise<PostV2[]> } - Array of post data, including requested expansions and fields.
   */
  async getPostsV2(
    ids: string[],
    options: {
      expansions?: TPostv2Expansion[];
      postFields?: TPostv2PostField[];
      pollFields?: TPostv2PollField[];
      mediaFields?: TPostv2MediaField[];
      userFields?: TPostv2UserField[];
      placeFields?: TPostv2PlaceField[];
    } = defaultOptions
  ): Promise<Post[]> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await getPostsV2(ids, this.auth, options);
  }

  /**
   * Updates the authentication state for the client.
   * @param auth The new authentication.
   */
  public updateAuth(auth: XAuth) {
    this.auth = auth;
  }

  public async authenticate(provider: XAuthProvider): Promise<void> {
    this.auth = new XAuth(provider);
    // Force initialization early to surface misconfiguration quickly
    await this.auth.isLoggedIn().catch(() => false);
  }

  /**
   * Get current authentication credentials
   * @returns {XAuth | null} Current authentication or null if not authenticated
   */
  public getAuth(): XAuth | null {
    return this.auth ?? null;
  }

  /**
   * Check if client is properly authenticated with X API v2 credentials
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
    if (!this.auth) return false;
    return await this.auth.isLoggedIn();
  }

  /**
   * Returns the currently logged in user
   * @returns The currently logged in user
   */
  public async me(): Promise<Profile | undefined> {
    if (!this.auth) return undefined;
    return this.auth.me();
  }

  /**
   * Login to X using API v2 credentials only.
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
    accessSecret?: string
  ): Promise<void> {
    // Only use API credentials for v2 authentication
    if (!appKey || !appSecret || !accessToken || !accessSecret) {
      throw new Error("X API v2 credentials are required for authentication");
    }

    // Build a fixed OAuth1 provider inline.
    const oauth1Provider: XOAuth1Provider = {
      mode: "env",
      getAccessToken: async () => accessToken,
      getOAuth1Credentials: async () => ({
        appKey: appKey,
        appSecret: appSecret,
        accessToken: accessToken,
        accessSecret: accessSecret,
      }),
    };
    this.auth = new XAuth(oauth1Provider);
  }

  /**
   * Log out of X.
   * With API v2 credentials, logout is a no-op.
   */
  public async logout(): Promise<void> {
    // API v2 uses static credentials - nothing to invalidate
  }

  /**
   * Sends a quote post.
   * @param text The text of the post.
   * @param quotedPostId The ID of the post to quote.
   * @param options Optional parameters, such as media data.
   * @returns The response from the X API.
   */
  public async sendQuotePost(
    text: string,
    quotedPostId: string,
    options?: {
      mediaData: { data: Buffer; mediaType: string }[];
    }
  ) {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await createQuotePostRequest(text, quotedPostId, this.auth, options?.mediaData);
  }

  /**
   * Delete a post with the given ID.
   * @param postId The ID of the post to delete.
   * @returns A promise that resolves when the post is deleted.
   */
  public async deletePost(postId: string): Promise<{ success: boolean }> {
    // Call the deletePost function from posts.ts
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    const result = await deletePost(postId, this.auth);
    return { success: result.ok };
  }

  /**
   * Likes a post with the given post ID.
   * @param postId The ID of the post to like.
   * @returns A promise that resolves when the post is liked.
   */
  public async likePost(postId: string): Promise<void> {
    // Call the likePost function from posts.ts
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    await likePost(postId, this.auth);
  }

  /**
   * Reposts a post with the given post ID.
   * @param postId The ID of the post to repost.
   * @returns A promise that resolves when the post is reposted.
   */
  public async repost(postId: string): Promise<void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    await repost(postId, this.auth);
  }

  /**
   * Unlikes a post with the given post ID.
   * @param postId The ID of the post to unlike.
   * @returns A promise that resolves when the post is unliked.
   */
  public async unlikePost(postId: string): Promise<void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    await unlikePost(postId, this.auth);
  }

  /**
   * Removes a repost of a post with the given post ID.
   * @param postId The ID of the post to unrepost.
   * @returns A promise that resolves when the repost is removed.
   */
  public async unrepost(postId: string): Promise<void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    await unrepost(postId, this.auth);
  }

  /**
   * Follows a user with the given user ID.
   * @param userId The user ID of the user to follow.
   * @returns A promise that resolves when the user is followed.
   */
  public async followUser(userName: string): Promise<void> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    // Call the followUser function from relationships.ts
    await followUser(userName, this.auth);
  }

  /**
   * Fetches direct message conversations.
   * Requires additional API permissions not included in basic access.
   */
  public async getDirectMessageConversations(
    _userId: string,
    _cursor?: string
  ): Promise<{ conversations: unknown[] }> {
    throw new Error("DM access requires elevated API permissions");
  }

  /**
   * Sends a direct message to a user.
   * Requires additional API permissions not included in basic access.
   */
  public async sendDirectMessage(_conversationId: string, _text: string): Promise<never> {
    throw new Error("DM access requires elevated API permissions");
  }

  private handleResponse<T>(res: RequestApiResult<T>): T {
    if (!res.success) {
      throw res.err;
    }

    return res.value;
  }

  /**
   * Retrieves all users who reposted the given post.
   * @param postId The ID of the post.
   * @returns An array of users (reposters).
   */
  public async getRepostersOfPost(postId: string): Promise<Reposter[]> {
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    return await getAllReposters(postId, this.auth);
  }

  /**
   * Fetches all quote posts for a given post ID, handling pagination automatically.
   * @param postId The ID of the post to fetch quotes for.
   * @param maxQuotes Maximum number of quotes to return (default: 100).
   * @returns An array of all quote posts.
   */
  public async fetchAllQuotedPosts(postId: string, maxQuotes: number = 100): Promise<Post[]> {
    const allQuotes: Post[] = [];

    try {
      let cursor: string | undefined;
      let totalFetched = 0;

      while (totalFetched < maxQuotes) {
        const batchSize = Math.min(40, maxQuotes - totalFetched);
        const page = await this.fetchQuotedPostsPage(postId, batchSize, cursor);

        if (!page.posts || page.posts.length === 0) {
          break;
        }

        allQuotes.push(...page.posts);
        totalFetched += page.posts.length;

        // Check if there's a next page
        if (!page.next) {
          break;
        }

        cursor = page.next;
      }

      return allQuotes.slice(0, maxQuotes);
    } catch (error) {
      console.error("Error fetching quoted posts:", error);
      throw error;
    }
  }

  /**
   * Fetches quote posts for a given post ID.
   * This method now uses a generator function internally.
   * @param postId The ID of the post to fetch quotes for.
   * @param maxQuotes Maximum number of quotes to return.
   * @param cursor Optional cursor for pagination.
   * @returns A promise that resolves to a QueryPostsResponse containing posts and the next cursor.
   */
  public async fetchQuotedPostsPage(
    postId: string,
    maxQuotes: number = 40,
    _cursor?: string
  ): Promise<QueryPostsResponse> {
    // Collect quotes from the generator
    const quotes: Post[] = [];
    let count = 0;

    // searchQuotedPosts doesn't support cursor, so we'll collect all quotes up to maxQuotes
    if (!this.auth) {
      throw new Error("X auth not initialized");
    }
    for await (const quote of searchQuotedPosts(postId, maxQuotes, this.auth)) {
      quotes.push(quote);
      count++;
      if (count >= maxQuotes) break;
    }

    return {
      posts: quotes,
      next: undefined, // X API v2 doesn't provide cursor for quote search
    };
  }
}

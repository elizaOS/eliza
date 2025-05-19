import type { Cookie } from 'tough-cookie';
import type {
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
} from 'twitter-api-v2';
import { type FetchTransformOptions, type RequestApiResult, bearerToken, requestApi } from './api';
import { type TwitterAuth, type TwitterAuthOptions, TwitterGuestAuth } from './auth';
import { TwitterUserAuth } from './auth-user';
import {
  type GrokChatOptions,
  type GrokChatResponse,
  createGrokConversation,
  grokChat,
} from './grok';
import {
  type DirectMessagesResponse,
  type SendDirectMessageResponse,
  getDirectMessageConversations,
  sendDirectMessage,
} from './messages';
import {
  type Profile,
  getEntityIdByScreenName,
  getProfile,
  getScreenNameByUserId,
} from './profile';
import {
  fetchProfileFollowers,
  fetchProfileFollowing,
  followUser,
  getFollowers,
  getFollowing,
} from './relationships';
import {
  SearchMode,
  fetchQuotedTweetsPage,
  fetchSearchProfiles,
  fetchSearchTweets,
  searchProfiles,
  searchQuotedTweets,
  searchTweets,
} from './search';
import {
  fetchAudioSpaceById,
  fetchAuthenticatePeriscope,
  fetchBrowseSpaceTopics,
  fetchCommunitySelectQuery,
  fetchLiveVideoStreamStatus,
  fetchLoginTwitterToken,
} from './spaces';
import { fetchFollowingTimeline } from './timeline-following';
import { fetchHomeTimeline } from './timeline-home';
import type { QueryProfilesResponse, QueryTweetsResponse } from './timeline-v1';
import { type TimelineArticle, type TimelineV2, parseTimelineTweetsV2 } from './timeline-v2';
import { getTrends } from './trends';
import {
  type PollData,
  type Retweeter,
  type Tweet,
  type TweetQuery,
  createCreateLongTweetRequest,
  createCreateNoteTweetRequest,
  createCreateTweetRequest,
  createCreateTweetRequestV2,
  createQuoteTweetRequest,
  defaultOptions,
  deleteTweet,
  fetchListTweets,
  getAllRetweeters,
  getArticle,
  getLatestTweet,
  getTweet,
  getTweetAnonymous,
  getTweetV2,
  getTweetWhere,
  getTweets,
  getTweetsAndReplies,
  getTweetsAndRepliesByUserId,
  getTweetsByUserId,
  getTweetsV2,
  getTweetsWhere,
  likeTweet,
  retweet,
} from './tweets';
import type {
  AudioSpace,
  Community,
  LiveVideoStreamStatus,
  LoginTwitterTokenResponse,
  Subtopic,
} from './types/spaces';

const twUrl = 'https://twitter.com';
const UserTweetsUrl = 'https://twitter.com/i/api/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets';

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
 * An interface to Twitter's undocumented API.
 * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
 */
export class Client {
  private auth!: TwitterAuth;
  private authTrends!: TwitterAuth;
  private token: string;

  /**
   * Creates a new Client object.
   * - Clients maintain their own guest tokens for Twitter's internal API.
   * - Reusing Client objects is recommended to minimize the time spent authenticating unnecessarily.
   */
  constructor(private readonly options?: Partial<ClientOptions>) {
    this.token = bearerToken;
    this.useGuestAuth();
  }

  /**
   * Initializes auth properties using a guest token.
   * Used when creating a new instance of this class, and when logging out.
   * @internal
   */
  private useGuestAuth() {
    this.auth = new TwitterGuestAuth(this.token, this.getAuthOptions());
    this.authTrends = new TwitterGuestAuth(this.token, this.getAuthOptions());
  }

  /**
   * Fetches a Twitter profile.
   * @param username The Twitter username of the profile to fetch, without an `@` at the beginning.
   * @returns The requested {@link Profile}.
   */
  public async getProfile(username: string): Promise<Profile> {
    const res = await getProfile(username, this.auth);
    return this.handleResponse(res);
  }

  /**
   * Fetches the user ID corresponding to the provided screen name.
   * @param screenName The Twitter screen name of the profile to fetch.
   * @returns The ID of the corresponding account.
   */
  public async getEntityIdByScreenName(screenName: string): Promise<string> {
    const res = await getEntityIdByScreenName(screenName, this.auth);
    return this.handleResponse(res);
  }

  /**
   *
   * @param userId The user ID of the profile to fetch.
   * @returns The screen name of the corresponding account.
   */
  public async getScreenNameByUserId(userId: string): Promise<string> {
    const response = await getScreenNameByUserId(userId, this.auth);
    return this.handleResponse(response);
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
    searchMode: SearchMode = SearchMode.Top
  ): AsyncGenerator<Tweet, void> {
    return searchTweets(query, maxTweets, searchMode, this.auth);
  }

  /**
   * Fetches profiles from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of tweets matching the provided filter(s).
   */
  public searchProfiles(query: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    return searchProfiles(query, maxProfiles, this.auth);
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
  public fetchSearchTweets(
    query: string,
    maxTweets: number,
    searchMode: SearchMode,
    cursor?: string
  ): Promise<QueryTweetsResponse> {
    return fetchSearchTweets(query, maxTweets, searchMode, this.auth, cursor);
  }

  /**
   * Fetches profiles from Twitter.
   * @param query The search query. Any Twitter-compatible query format can be used.
   * @param maxProfiles The maximum number of profiles to return.
   * @param cursor The search cursor, which can be passed into further requests for more results.
   * @returns A page of results, containing a cursor that can be used in further requests.
   */
  public fetchSearchProfiles(
    query: string,
    maxProfiles: number,
    cursor?: string
  ): Promise<QueryProfilesResponse> {
    return fetchSearchProfiles(query, maxProfiles, this.auth, cursor);
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
    cursor?: string
  ): Promise<QueryTweetsResponse> {
    return fetchListTweets(listId, maxTweets, cursor, this.auth);
  }

  /**
   * Fetch the profiles a user is following
   * @param userId The user whose following should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of following profiles for the provided user.
   */
  public getFollowing(userId: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    return getFollowing(userId, maxProfiles, this.auth);
  }

  /**
   * Fetch the profiles that follow a user
   * @param userId The user whose followers should be returned
   * @param maxProfiles The maximum number of profiles to return.
   * @returns An {@link AsyncGenerator} of profiles following the provided user.
   */
  public getFollowers(userId: string, maxProfiles: number): AsyncGenerator<Profile, void> {
    return getFollowers(userId, maxProfiles, this.auth);
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
    cursor?: string
  ): Promise<QueryProfilesResponse> {
    return fetchProfileFollowing(userId, maxProfiles, this.auth, cursor);
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
    cursor?: string
  ): Promise<QueryProfilesResponse> {
    return fetchProfileFollowers(userId, maxProfiles, this.auth, cursor);
  }

  /**
   * Fetches the home timeline for the current user. (for you feed)
   * @param count The number of tweets to fetch.
   * @param seenTweetIds An array of tweet IDs that have already been seen.
   * @returns A promise that resolves to the home timeline response.
   */
  public async fetchHomeTimeline(count: number, seenTweetIds: string[]): Promise<any[]> {
    return await fetchHomeTimeline(count, seenTweetIds, this.auth);
  }

  /**
   * Fetches the home timeline for the current user. (following feed)
   * @param count The number of tweets to fetch.
   * @param seenTweetIds An array of tweet IDs that have already been seen.
   * @returns A promise that resolves to the home timeline response.
   */
  public async fetchFollowingTimeline(count: number, seenTweetIds: string[]): Promise<any[]> {
    return await fetchFollowingTimeline(count, seenTweetIds, this.auth);
  }

  async getUserTweets(
    userId: string,
    maxTweets = 200,
    cursor?: string
  ): Promise<{ tweets: Tweet[]; next?: string }> {
    if (maxTweets > 200) {
      maxTweets = 200;
    }

    const variables: Record<string, any> = {
      userId,
      count: maxTweets,
      includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true,
    };

    if (cursor) {
      variables.cursor = cursor;
    }

    const features = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
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
      responsive_web_enhance_cards_enabled: false,
    };

    const fieldToggles = {
      withArticlePlainText: false,
    };

    const res = await requestApi<TimelineV2>(
      `${UserTweetsUrl}?variables=${encodeURIComponent(
        JSON.stringify(variables)
      )}&features=${encodeURIComponent(JSON.stringify(features))}&fieldToggles=${encodeURIComponent(
        JSON.stringify(fieldToggles)
      )}`,
      this.auth
    );

    if (!res.success) {
      throw (res as any).err;
    }

    const timelineV2 = parseTimelineTweetsV2(res.value);
    return {
      tweets: timelineV2.tweets,
      next: timelineV2.next,
    };
  }

  async *getUserTweetsIterator(userId: string, maxTweets = 200): AsyncGenerator<Tweet, void> {
    let cursor: string | undefined;
    let retrievedTweets = 0;

    while (retrievedTweets < maxTweets) {
      const response = await this.getUserTweets(userId, maxTweets - retrievedTweets, cursor);

      for (const tweet of response.tweets) {
        yield tweet;
        retrievedTweets++;
        if (retrievedTweets >= maxTweets) {
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
   * Fetches the current trends from Twitter.
   * @returns The current list of trends.
   */
  public getTrends(): Promise<string[]> {
    return getTrends(this.authTrends);
  }

  /**
   * Fetches tweets from a Twitter user.
   * @param user The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweets(user: string, maxTweets = 200): AsyncGenerator<Tweet> {
    return getTweets(user, maxTweets, this.auth);
  }

  /**
   * Fetches tweets from a Twitter user using their ID.
   * @param userId The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsByUserId(userId: string, maxTweets = 200): AsyncGenerator<Tweet, void> {
    return getTweetsByUserId(userId, maxTweets, this.auth);
  }

  /**
   * Send a tweet
   * @param text The text of the tweet
   * @param tweetId The id of the tweet to reply to
   * @param mediaData Optional media data
   * @returns
   */

  async sendTweet(
    text: string,
    replyToTweetId?: string,
    mediaData?: { data: Buffer; mediaType: string }[],
    hideLinkPreview?: boolean
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error('Text is required');
    }
    if (text.toLowerCase().startsWith('error:')) {
      throw new Error('Error sending tweet: ' + text);
    }
    return await createCreateTweetRequest(
      text,
      this.auth,
      replyToTweetId,
      mediaData,
      hideLinkPreview
    );
  }

  async sendNoteTweet(
    text: string,
    replyToTweetId?: string,
    mediaData?: { data: Buffer; mediaType: string }[]
  ) {
    if (!text || text.trim().length === 0) {
      throw new Error('Text is required');
    }
    if (text.toLowerCase().startsWith('error:')) {
      throw new Error('Error sending note tweet: ' + text);
    }
    return await createCreateNoteTweetRequest(text, this.auth, replyToTweetId, mediaData);
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
    mediaData?: { data: Buffer; mediaType: string }[]
  ) {
    return await createCreateLongTweetRequest(text, this.auth, replyToTweetId, mediaData);
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
    }
  ) {
    return await createCreateTweetRequestV2(text, this.auth, replyToTweetId, options);
  }

  /**
   * Fetches tweets and replies from a Twitter user.
   * @param user The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsAndReplies(user: string, maxTweets = 200): AsyncGenerator<Tweet> {
    return getTweetsAndReplies(user, maxTweets, this.auth);
  }

  /**
   * Fetches tweets and replies from a Twitter user using their ID.
   * @param userId The user whose tweets should be returned.
   * @param maxTweets The maximum number of tweets to return. Defaults to `200`.
   * @returns An {@link AsyncGenerator} of tweets from the provided user.
   */
  public getTweetsAndRepliesByUserId(userId: string, maxTweets = 200): AsyncGenerator<Tweet, void> {
    return getTweetsAndRepliesByUserId(userId, maxTweets, this.auth);
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
  public getTweetWhere(tweets: AsyncIterable<Tweet>, query: TweetQuery): Promise<Tweet | null> {
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
  public getTweetsWhere(tweets: AsyncIterable<Tweet>, query: TweetQuery): Promise<Tweet[]> {
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
    max = 200
  ): Promise<Tweet | null | undefined> {
    return getLatestTweet(user, includeRetweets, max, this.auth);
  }

  /**
   * Fetches a single tweet.
   * @param id The ID of the tweet to fetch.
   * @returns The {@link Tweet} object, or `null` if it couldn't be fetched.
   */
  public getTweet(id: string): Promise<Tweet | null> {
    if (this.auth instanceof TwitterUserAuth) {
      return getTweet(id, this.auth);
    }
    return getTweetAnonymous(id, this.auth);
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
    } = defaultOptions
  ): Promise<Tweet | null> {
    return await getTweetV2(id, this.auth, options);
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
    } = defaultOptions
  ): Promise<Tweet[]> {
    return await getTweetsV2(ids, this.auth, options);
  }

  /**
   * Returns if the client has a guest token. The token may not be valid.
   * @returns `true` if the client has a guest token; otherwise `false`.
   */
  public hasGuestToken(): boolean {
    return this.auth.hasToken() || this.authTrends.hasToken();
  }

  /**
   * Returns if the client is logged in as a real user.
   * @returns `true` if the client is logged in with a real user account; otherwise `false`.
   */
  public async isLoggedIn(): Promise<boolean> {
    return (await this.auth.isLoggedIn()) && (await this.authTrends.isLoggedIn());
  }

  /**
   * Returns the currently logged in user
   * @returns The currently logged in user
   */
  public async me(): Promise<Profile | undefined> {
    return this.auth.me();
  }

  /**
   * Login to Twitter as a real Twitter account. This enables running
   * searches.
   * @param username The username of the Twitter account to login with.
   * @param password The password of the Twitter account to login with.
   * @param email The email to log in with, if you have email confirmation enabled.
   * @param twoFactorSecret The secret to generate two factor authentication tokens with, if you have two factor authentication enabled.
   */
  public async login(
    username: string,
    password: string,
    email?: string,
    twoFactorSecret?: string,
    appKey?: string,
    appSecret?: string,
    accessToken?: string,
    accessSecret?: string
  ): Promise<void> {
    // Swap in a real authorizer for all requests
    const userAuth = new TwitterUserAuth(this.token, this.getAuthOptions());
    await userAuth.login(
      username,
      password,
      email,
      twoFactorSecret,
      appKey,
      appSecret,
      accessToken,
      accessSecret
    );
    this.auth = userAuth;
    this.authTrends = userAuth;
  }

  /**
   * Log out of Twitter.
   */
  public async logout(): Promise<void> {
    await this.auth.logout();
    await this.authTrends.logout();

    // Swap in guest authorizers for all requests
    this.useGuestAuth();
  }

  /**
   * Retrieves all cookies for the current session.
   * @returns All cookies for the current session.
   */
  public async getCookies(): Promise<Cookie[]> {
    return await this.authTrends
      .cookieJar()
      .getCookies(typeof document !== 'undefined' ? document.location.toString() : twUrl);
  }

  /**
   * Set cookies for the current session.
   * @param cookies The cookies to set for the current session.
   */
  public async setCookies(cookies: (string | Cookie)[]): Promise<void> {
    const userAuth = new TwitterUserAuth(this.token, this.getAuthOptions());
    for (const cookie of cookies) {
      await userAuth.cookieJar().setCookie(cookie, twUrl);
    }

    this.auth = userAuth;
    this.authTrends = userAuth;
  }

  /**
   * Clear all cookies for the current session.
   */
  public async clearCookies(): Promise<void> {
    await this.auth.cookieJar().removeAllCookies();
    await this.authTrends.cookieJar().removeAllCookies();
  }

  /**
   * Sets the optional cookie to be used in requests.
   * @param _cookie The cookie to be used in requests.
   * @deprecated This function no longer represents any part of Twitter's auth flow.
   * @returns This client instance.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public withCookie(_cookie: string): Client {
    console.warn(
      'Warning: Client#withCookie is deprecated and will be removed in a later version. Use Client#login or Client#setCookies instead.'
    );
    return this;
  }

  /**
   * Sets the optional CSRF token to be used in requests.
   * @param _token The CSRF token to be used in requests.
   * @deprecated This function no longer represents any part of Twitter's auth flow.
   * @returns This client instance.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public withXCsrfToken(_token: string): Client {
    console.warn(
      'Warning: Client#withXCsrfToken is deprecated and will be removed in a later version.'
    );
    return this;
  }

  /**
   * Sends a quote tweet.
   * @param text The text of the tweet.
   * @param quotedTweetId The ID of the tweet to quote.
   * @param options Optional parameters, such as media data.
   * @returns The response from the Twitter API.
   */
  public async sendQuoteTweet(
    text: string,
    quotedTweetId: string,
    options?: {
      mediaData: { data: Buffer; mediaType: string }[];
    }
  ) {
    return await createQuoteTweetRequest(text, quotedTweetId, this.auth, options?.mediaData);
  }

  /**
   * Delete a tweet with the given ID.
   * @param tweetId The ID of the tweet to delete.
   * @returns A promise that resolves when the tweet is deleted.
   */
  public async deleteTweet(tweetId: string): Promise<Response> {
    // Call the deleteTweet function from tweets.ts
    return await deleteTweet(tweetId, this.auth);
  }

  /**
   * Likes a tweet with the given tweet ID.
   * @param tweetId The ID of the tweet to like.
   * @returns A promise that resolves when the tweet is liked.
   */
  public async likeTweet(tweetId: string): Promise<void> {
    // Call the likeTweet function from tweets.ts
    await likeTweet(tweetId, this.auth);
  }

  /**
   * Retweets a tweet with the given tweet ID.
   * @param tweetId The ID of the tweet to retweet.
   * @returns A promise that resolves when the tweet is retweeted.
   */
  public async retweet(tweetId: string): Promise<void> {
    // Call the retweet function from tweets.ts
    await retweet(tweetId, this.auth);
  }

  /**
   * Follows a user with the given user ID.
   * @param userId The user ID of the user to follow.
   * @returns A promise that resolves when the user is followed.
   */
  public async followUser(userName: string): Promise<void> {
    // Call the followUser function from relationships.ts
    await followUser(userName, this.auth);
  }

  /**
   * Fetches direct message conversations
   * @param count Number of conversations to fetch (default: 50)
   * @param cursor Pagination cursor for fetching more conversations
   * @returns Array of DM conversations and other details
   */
  public async getDirectMessageConversations(
    userId: string,
    cursor?: string
  ): Promise<DirectMessagesResponse> {
    return await getDirectMessageConversations(userId, this.auth, cursor);
  }

  /**
   * Sends a direct message to a user.
   * @param conversationId The ID of the conversation to send the message to.
   * @param text The text of the message to send.
   * @returns The response from the Twitter API.
   */
  public async sendDirectMessage(
    conversationId: string,
    text: string
  ): Promise<SendDirectMessageResponse> {
    return await sendDirectMessage(this.auth, conversationId, text);
  }

  private getAuthOptions(): Partial<TwitterAuthOptions> {
    return {
      fetch: this.options?.fetch,
      transform: this.options?.transform,
    };
  }

  private handleResponse<T>(res: RequestApiResult<T>): T {
    if (!res.success) {
      throw (res as any).err;
    }

    return res.value;
  }

  /**
   * Retrieves the details of an Audio Space by its ID.
   * @param id The ID of the Audio Space.
   * @returns The details of the Audio Space.
   */
  public async getAudioSpaceById(id: string): Promise<AudioSpace> {
    const variables = {
      id,
      isMetatagsQuery: false,
      withReplays: true,
      withListeners: true,
    };

    return await fetchAudioSpaceById(variables, this.auth);
  }

  /**
   * Retrieves available space topics.
   * @returns An array of space topics.
   */
  public async browseSpaceTopics(): Promise<Subtopic[]> {
    return await fetchBrowseSpaceTopics(this.auth);
  }

  /**
   * Retrieves available communities.
   * @returns An array of communities.
   */
  public async communitySelectQuery(): Promise<Community[]> {
    return await fetchCommunitySelectQuery(this.auth);
  }

  /**
   * Retrieves the status of an Audio Space stream by its media key.
   * @param mediaKey The media key of the Audio Space.
   * @returns The status of the Audio Space stream.
   */
  public async getAudioSpaceStreamStatus(mediaKey: string): Promise<LiveVideoStreamStatus> {
    return await fetchLiveVideoStreamStatus(mediaKey, this.auth);
  }

  /**
   * Retrieves the status of an Audio Space by its ID.
   * This method internally fetches the Audio Space to obtain the media key,
   * then retrieves the stream status using the media key.
   * @param audioSpaceId The ID of the Audio Space.
   * @returns The status of the Audio Space stream.
   */
  public async getAudioSpaceStatus(audioSpaceId: string): Promise<LiveVideoStreamStatus> {
    const audioSpace = await this.getAudioSpaceById(audioSpaceId);

    const mediaKey = audioSpace.metadata.media_key;
    if (!mediaKey) {
      throw new Error('Media Key not found in Audio Space metadata.');
    }

    return await this.getAudioSpaceStreamStatus(mediaKey);
  }

  /**
   * Authenticates Periscope to obtain a token.
   * @returns The Periscope authentication token.
   */
  public async authenticatePeriscope(): Promise<string> {
    return await fetchAuthenticatePeriscope(this.auth);
  }

  /**
   * Logs in to Twitter via Proxsee using the Periscope JWT.
   * @param jwt The JWT obtained from AuthenticatePeriscope.
   * @returns The response containing the cookie and user information.
   */
  public async loginTwitterToken(jwt: string): Promise<LoginTwitterTokenResponse> {
    return await fetchLoginTwitterToken(jwt, this.auth);
  }

  /**
   * Orchestrates the flow: get token -> login -> return Periscope cookie
   */
  public async getPeriscopeCookie(): Promise<string> {
    const periscopeToken = await this.authenticatePeriscope();

    const loginResponse = await this.loginTwitterToken(periscopeToken);

    return loginResponse.cookie;
  }

  /**
   * Fetches a article (long form tweet) by its ID.
   * @param id The ID of the article to fetch. In the format of (http://x.com/i/article/id)
   * @returns The {@link TimelineArticle} object, or `null` if it couldn't be fetched.
   */
  public getArticle(id: string): Promise<TimelineArticle | null> {
    return getArticle(id, this.auth);
  }

  /**
   * Creates a new conversation with Grok.
   * @returns A promise that resolves to the conversation ID string.
   */
  public async createGrokConversation(): Promise<string> {
    return await createGrokConversation(this.auth);
  }

  /**
   * Interact with Grok in a chat-like manner.
   * @param options The options for the Grok chat interaction.
   * @param {GrokMessage[]} options.messages - Array of messages in the conversation.
   * @param {string} [options.conversationId] - Optional ID of an existing conversation.
   * @param {boolean} [options.returnSearchResults] - Whether to return search results.
   * @param {boolean} [options.returnCitations] - Whether to return citations.
   * @returns A promise that resolves to the Grok chat response.
   */
  public async grokChat(options: GrokChatOptions): Promise<GrokChatResponse> {
    return await grokChat(options, this.auth);
  }

  /**
   * Retrieves all users who retweeted the given tweet.
   * @param tweetId The ID of the tweet.
   * @returns An array of users (retweeters).
   */
  public async getRetweetersOfTweet(tweetId: string): Promise<Retweeter[]> {
    return await getAllRetweeters(tweetId, this.auth);
  }

  /**
   * Fetches all tweets quoting a given tweet ID by chaining requests
   * until no more pages are available.
   * @param quotedTweetId The tweet ID to find quotes of.
   * @param maxTweetsPerPage Max tweets per page (default 20).
   * @returns An array of all Tweet objects referencing the given tweet.
   */
  public async getAllQuotedTweets(quotedTweetId: string, maxTweetsPerPage = 20): Promise<Tweet[]> {
    const allQuotes: Tweet[] = [];
    let cursor: string | undefined;
    let prevCursor: string | undefined;

    while (true) {
      const page = await fetchQuotedTweetsPage(quotedTweetId, maxTweetsPerPage, this.auth, cursor);

      // If there's no new tweets, stop
      if (!page.tweets || page.tweets.length === 0) {
        break;
      }

      allQuotes.push(...page.tweets);

      // If next is missing or same => stop
      if (!page.next || page.next === cursor || page.next === prevCursor) {
        break;
      }

      // Move cursors
      prevCursor = cursor;
      cursor = page.next;
    }

    return allQuotes;
  }
}

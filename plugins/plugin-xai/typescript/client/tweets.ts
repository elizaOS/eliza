import type {
  ApiV2Includes,
  MediaObjectV2,
  PlaceV2,
  PollV2,
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
  TweetV2,
  UserV2,
} from "twitter-api-v2";
import type { TwitterAuth } from "./auth";
import { getEntityIdByScreenName } from "./profile";
import type { QueryTweetsResponse } from "./types";

/**
 * Default options for Twitter API v2 request parameters.
 * @typedef {Object} defaultOptions
 * @property {TTweetv2Expansion[]} expansions - List of expansions to include in the request.
 * @property {TTweetv2TweetField[]} tweetFields - List of tweet fields to include in the request.
 * @property {TTweetv2PollField[]} pollFields - List of poll fields to include in the request.
 * @property {TTweetv2MediaField[]} mediaFields - List of media fields to include in the request.
 * @property {TTweetv2UserField[]} userFields - List of user fields to include in the request.
 * @property {TTweetv2PlaceField[]} placeFields - List of place fields to include in the request.
 */
export const defaultOptions = {
  expansions: [
    "attachments.poll_ids",
    "attachments.media_keys",
    "author_id",
    "referenced_tweets.id",
    "in_reply_to_user_id",
    "edit_history_tweet_ids",
    "geo.place_id",
    "entities.mentions.username",
    "referenced_tweets.id.author_id",
  ] as TTweetv2Expansion[],
  tweetFields: [
    "attachments",
    "author_id",
    "context_annotations",
    "conversation_id",
    "created_at",
    "entities",
    "geo",
    "id",
    "in_reply_to_user_id",
    "lang",
    "public_metrics",
    "edit_controls",
    "possibly_sensitive",
    "referenced_tweets",
    "reply_settings",
    "source",
    "text",
    "withheld",
    "note_tweet",
  ] as TTweetv2TweetField[],
  pollFields: [
    "duration_minutes",
    "end_datetime",
    "id",
    "options",
    "voting_status",
  ] as TTweetv2PollField[],
  mediaFields: [
    "duration_ms",
    "height",
    "media_key",
    "preview_image_url",
    "type",
    "url",
    "width",
    "public_metrics",
    "alt_text",
    "variants",
  ] as TTweetv2MediaField[],
  userFields: [
    "created_at",
    "description",
    "entities",
    "id",
    "location",
    "name",
    "profile_image_url",
    "protected",
    "public_metrics",
    "url",
    "username",
    "verified",
    "withheld",
  ] as TTweetv2UserField[],
  placeFields: [
    "contained_within",
    "country",
    "country_code",
    "full_name",
    "geo",
    "id",
    "name",
    "place_type",
  ] as TTweetv2PlaceField[],
};
/**
 * Interface representing a mention.
 * @typedef {Object} Mention
 * @property {string} id - The unique identifier for the mention.
 * @property {string} [username] - The username associated with the mention.
 * @property {string} [name] - The name associated with the mention.
 */
export interface Mention {
  id: string;
  username?: string;
  name?: string;
}

/**
 * Interface representing a photo object.
 * @interface
 * @property {string} id - The unique identifier for the photo.
 * @property {string} url - The URL for the photo image.
 * @property {string} [alt_text] - The alternative text for the photo image. Optional.
 */
export interface Photo {
  id: string;
  url: string;
  alt_text: string | undefined;
}

/**
 * Interface representing a video object.
 * @typedef {Object} Video
 * @property {string} id - The unique identifier for the video.
 * @property {string} preview - The URL for the preview image of the video.
 * @property {string} [url] - The optional URL for the video.
 */

export interface Video {
  id: string;
  preview: string;
  url?: string;
}

/**
 * Interface representing a raw place object.
 * @typedef {Object} PlaceRaw
 * @property {string} [id] - The unique identifier of the place.
 * @property {string} [place_type] - The type of the place.
 * @property {string} [name] - The name of the place.
 * @property {string} [full_name] - The full name of the place.
 * @property {string} [country_code] - The country code of the place.
 * @property {string} [country] - The country name of the place.
 * @property {Object} [bounding_box] - The bounding box coordinates of the place.
 * @property {string} [bounding_box.type] - The type of the bounding box.
 * @property {number[][][]} [bounding_box.coordinates] - The coordinates of the bounding box in an array format.
 */
export interface PlaceRaw {
  id?: string;
  place_type?: string;
  name?: string;
  full_name?: string;
  country_code?: string;
  country?: string;
  bounding_box?: {
    type?: string;
    coordinates?: number[][][];
  };
}

/**
 * Interface representing poll data.
 *
 * @property {string} [id] - The unique identifier for the poll.
 * @property {string} [end_datetime] - The end date and time for the poll.
 * @property {string} [voting_status] - The status of the voting process.
 * @property {number} duration_minutes - The duration of the poll in minutes.
 * @property {PollOption[]} options - An array of poll options.
 */
export interface PollData {
  id?: string;
  end_datetime?: string;
  voting_status?: string;
  duration_minutes: number;
  options: PollOption[];
}

/**
 * Interface representing a poll option.
 * @typedef {Object} PollOption
 * @property {number} [position] - The position of the option.
 * @property {string} label - The label of the option.
 * @property {number} [votes] - The number of votes for the option.
 */
export interface PollOption {
  position?: number;
  label: string;
  votes?: number;
}

/**
 * A parsed Tweet object.
 */
/**
 * Represents a Tweet on Twitter.
 * @typedef { Object } Tweet
 * @property { number } [bookmarkCount] - The number of times this Tweet has been bookmarked.
 * @property { string } [conversationId] - The ID of the conversation this Tweet is a part of.
 * @property {string[]} hashtags - An array of hashtags mentioned in the Tweet.
 * @property { string } [html] - The HTML content of the Tweet.
 * @property { string } [id] - The unique ID of the Tweet.
 * @property { Tweet } [inReplyToStatus] - The Tweet that this Tweet is in reply to.
 * @property { string } [inReplyToStatusId] - The ID of the Tweet that this Tweet is in reply to.
 * @property { boolean } [isQuoted] - Indicates if this Tweet is a quote of another Tweet.
 * @property { boolean } [isPin] - Indicates if this Tweet is pinned.
 * @property { boolean } [isReply] - Indicates if this Tweet is a reply to another Tweet.
 * @property { boolean } [isRetweet] - Indicates if this Tweet is a retweet.
 * @property { boolean } [isSelfThread] - Indicates if this Tweet is part of a self thread.
 * @property { string } [language] - The language of the Tweet.
 * @property { number } [likes] - The number of likes on the Tweet.
 * @property { string } [name] - The name associated with the Tweet.
 * @property {Mention[]} mentions - An array of mentions in the Tweet.
 * @property { string } [permanentUrl] - The permanent URL of the Tweet.
 * @property {Photo[]} photos - An array of photos attached to the Tweet.
 * @property { PlaceRaw } [place] - The place associated with the Tweet.
 * @property { Tweet } [quotedStatus] - The quoted Tweet.
 * @property { string } [quotedStatusId] - The ID of the quoted Tweet.
 * @property { number } [quotes] - The number of times this Tweet has been quoted.
 * @property { number } [replies] - The number of replies to the Tweet.
 * @property { number } [retweets] - The number of retweets on the Tweet.
 * @property { Tweet } [retweetedStatus] - The status that was retweeted.
 * @property { string } [retweetedStatusId] - The ID of the retweeted status.
 * @property { string } [text] - The text content of the Tweet.
 * @property {Tweet[]} thread - An array representing a Twitter thread.
 * @property { Date } [timeParsed] - The parsed timestamp of the Tweet.
 * @property { number } [timestamp] - The timestamp of the Tweet.
 * @property {string[]} urls - An array of URLs mentioned in the Tweet.
 * @property { string } [userId] - The ID of the user who posted the Tweet.
 * @property { string } [username] - The username of the user who posted the Tweet.
 * @property {Video[]} videos - An array of videos attached to the Tweet.
 * @property { number } [views] - The number of views on the Tweet.
 * @property { boolean } [sensitiveContent] - Indicates if the Tweet contains sensitive content.
 * @property {PollV2 | null} [poll] - The poll attached to the Tweet, if any.
 */
export interface Tweet {
  bookmarkCount?: number;
  conversationId?: string;
  hashtags: string[];
  html?: string;
  id?: string;
  inReplyToStatus?: Tweet;
  inReplyToStatusId?: string;
  isQuoted?: boolean;
  isPin?: boolean;
  isReply?: boolean;
  isRetweet?: boolean;
  isSelfThread?: boolean;
  language?: string;
  likes?: number;
  name?: string;
  mentions: Mention[];
  permanentUrl?: string;
  photos: Photo[];
  place?: PlaceRaw;
  quotedStatus?: Tweet;
  quotedStatusId?: string;
  quotes?: number;
  replies?: number;
  retweets?: number;
  retweetedStatus?: Tweet;
  retweetedStatusId?: string;
  text?: string;
  thread: Tweet[];
  timeParsed?: Date;
  timestamp?: number;
  urls: string[];
  userId?: string;
  username?: string;
  videos: Video[];
  views?: number;
  sensitiveContent?: boolean;
  poll?: PollV2 | null;
}

export interface Retweeter {
  rest_id: string;
  screen_name: string;
  name: string;
  description?: string;
}

export type TweetQuery = Partial<Tweet> | ((tweet: Tweet) => boolean | Promise<boolean>);

export async function fetchTweets(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.userTimeline(userId, {
      max_results: Math.min(maxTweets, 100),
      exclude: ["retweets", "replies"],
      "tweet.fields": [
        "id",
        "text",
        "created_at",
        "author_id",
        "referenced_tweets",
        "entities",
        "public_metrics",
        "attachments",
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedTweets: Tweet[] = [];

    // Use the paginator's built-in methods to access data
    for await (const tweet of response) {
      convertedTweets.push(parseTweetV2ToV1(tweet, response.includes));
      if (convertedTweets.length >= maxTweets) break;
    }

    return {
      tweets: convertedTweets,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch tweets: ${message}`);
  }
}

export async function fetchTweetsAndReplies(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  const client = await auth.getV2Client();

  try {
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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedTweets: Tweet[] = [];

    // Use the paginator's built-in methods to access data
    for await (const tweet of response) {
      convertedTweets.push(parseTweetV2ToV1(tweet, response.includes));
      if (convertedTweets.length >= maxTweets) break;
    }

    return {
      tweets: convertedTweets,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch tweets and replies: ${message}`);
  }
}

export async function createCreateTweetRequestV2(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  options?: {
    poll?: PollData;
  }
) {
  const v2client = await auth.getV2Client();
  if (v2client == null) {
    throw new Error("V2 client is not initialized");
  }
  const { poll } = options || {};
  let tweetConfig: {
    text: string;
    poll?: { options: string[]; duration_minutes: number };
    reply?: { in_reply_to_tweet_id: string };
  };
  if (poll) {
    tweetConfig = {
      text,
      poll: {
        options: poll?.options.map((option) => option.label) ?? [],
        duration_minutes: poll?.duration_minutes ?? 60,
      },
    };
  } else if (tweetId) {
    tweetConfig = {
      text,
      reply: {
        in_reply_to_tweet_id: tweetId,
      },
    };
  } else {
    tweetConfig = {
      text,
    };
  }
  const tweetResponse = await v2client.v2.tweet(tweetConfig);
  let optionsConfig = {};
  if (options?.poll) {
    optionsConfig = {
      expansions: ["attachments.poll_ids"],
      pollFields: ["options", "duration_minutes", "end_datetime", "voting_status"],
    };
  }
  return await getTweetV2(tweetResponse.data.id, auth, optionsConfig);
}

export function parseTweetV2ToV1(tweetV2: TweetV2, includes?: ApiV2Includes): Tweet {
  const parsedTweet: Tweet = {
    id: tweetV2.id,
    text: tweetV2.text ?? "",
    hashtags: tweetV2.entities?.hashtags?.map((tag) => tag.tag) ?? [],
    mentions:
      tweetV2.entities?.mentions?.map((mention) => ({
        id: mention.id,
        username: mention.username,
      })) ?? [],
    urls: tweetV2.entities?.urls?.map((url) => url.url) ?? [],
    likes: tweetV2.public_metrics?.like_count ?? 0,
    retweets: tweetV2.public_metrics?.retweet_count ?? 0,
    replies: tweetV2.public_metrics?.reply_count ?? 0,
    quotes: tweetV2.public_metrics?.quote_count ?? 0,
    views: tweetV2.public_metrics?.impression_count ?? 0,
    userId: tweetV2.author_id,
    conversationId: tweetV2.conversation_id,
    photos: [],
    videos: [],
    poll: null,
    username: "",
    name: "",
    thread: [],
    timestamp: tweetV2.created_at
      ? new Date(tweetV2.created_at).getTime() / 1000
      : Date.now() / 1000,
    permanentUrl: `https://twitter.com/i/status/${tweetV2.id}`,
    // Check for referenced tweets
    isReply: tweetV2.referenced_tweets?.some((ref) => ref.type === "replied_to") ?? false,
    isRetweet: tweetV2.referenced_tweets?.some((ref) => ref.type === "retweeted") ?? false,
    isQuoted: tweetV2.referenced_tweets?.some((ref) => ref.type === "quoted") ?? false,
    inReplyToStatusId: tweetV2.referenced_tweets?.find((ref) => ref.type === "replied_to")?.id,
    quotedStatusId: tweetV2.referenced_tweets?.find((ref) => ref.type === "quoted")?.id,
    retweetedStatusId: tweetV2.referenced_tweets?.find((ref) => ref.type === "retweeted")?.id,
  };

  // Process Polls
  if (includes?.polls?.length) {
    const poll = includes.polls[0];
    parsedTweet.poll = {
      id: poll.id,
      end_datetime: poll.end_datetime,
      options: poll.options.map((option) => ({
        position: option.position,
        label: option.label,
        votes: option.votes,
      })),
      voting_status: poll.voting_status,
    };
  }

  // Process Media (photos and videos)
  if (includes?.media?.length) {
    includes.media.forEach((media: MediaObjectV2) => {
      if (media.type === "photo") {
        parsedTweet.photos.push({
          id: media.media_key,
          url: media.url ?? "",
          alt_text: media.alt_text ?? "",
        });
      } else if (media.type === "video" || media.type === "animated_gif") {
        parsedTweet.videos.push({
          id: media.media_key,
          preview: media.preview_image_url ?? "",
          url: media.variants?.find((variant) => variant.content_type === "video/mp4")?.url ?? "",
        });
      }
    });
  }

  // Process User (for author info)
  if (includes?.users?.length) {
    const user = includes.users.find((user: UserV2) => user.id === tweetV2.author_id);
    if (user) {
      parsedTweet.username = user.username ?? "";
      parsedTweet.name = user.name ?? "";
    }
  }

  // Process Place (if any)
  if (tweetV2?.geo?.place_id && includes?.places?.length) {
    const place = includes.places.find((place: PlaceV2) => place.id === tweetV2?.geo?.place_id);
    if (place) {
      parsedTweet.place = {
        id: place.id,
        full_name: place.full_name ?? "",
        country: place.country ?? "",
        country_code: place.country_code ?? "",
        name: place.name ?? "",
        place_type: place.place_type,
      };
    }
  }

  return parsedTweet;
}

export async function createCreateTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[],
  _hideLinkPreview = false
) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const tweetConfig: {
      text: string;
      reply?: { in_reply_to_tweet_id: string };
      poll?: { options: string[]; duration_minutes: number };
    } = {
      text,
    };

    // Handle media uploads if provided
    if (mediaData && mediaData.length > 0) {
      // TODO: Implement Twitter API v1.1 Media Upload endpoint for media attachments
      console.warn("Media upload requires Twitter API v1.1 Media Upload endpoint");
    }

    // Handle reply
    if (tweetId) {
      tweetConfig.reply = {
        in_reply_to_tweet_id: tweetId,
      };
    }

    const result = await v2client.v2.tweet(tweetConfig);

    return {
      ok: true,
      json: async () => result,
      data: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create tweet: ${message}`);
  }
}

export async function createCreateNoteTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  // Twitter API v2 doesn't have a separate endpoint for "note tweets"
  // Long tweets are handled automatically by the v2 tweet endpoint
  return createCreateTweetRequest(text, auth, tweetId, mediaData);
}

export async function fetchListTweets(
  listId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.listTweets(listId, {
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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedTweets: Tweet[] = [];

    // Use the paginator's built-in methods to access data
    for await (const tweet of response) {
      convertedTweets.push(parseTweetV2ToV1(tweet, response.includes));
      if (convertedTweets.length >= maxTweets) break;
    }

    return {
      tweets: convertedTweets,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch list tweets: ${message}`);
  }
}

export async function deleteTweet(tweetId: string, auth: TwitterAuth) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const result = await v2client.v2.deleteTweet(tweetId);
    return {
      ok: true,
      success: true,
      json: async () => result,
      data: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete tweet: ${message}`);
  }
}

export async function* getTweets(
  user: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  const userIdRes = await getEntityIdByScreenName(user, auth);

  if (!userIdRes.success) {
    throw userIdRes.err;
  }

  const { value: userId } = userIdRes;

  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxTweets) {
    const response = await fetchTweets(userId, maxTweets - totalFetched, cursor, auth);

    for (const tweet of response.tweets) {
      yield tweet;
      totalFetched++;
      if (totalFetched >= maxTweets) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getTweetsByUserId(
  userId: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxTweets) {
    const response = await fetchTweets(userId, maxTweets - totalFetched, cursor, auth);

    for (const tweet of response.tweets) {
      yield tweet;
      totalFetched++;
      if (totalFetched >= maxTweets) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getTweetsAndReplies(
  user: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  const userIdRes = await getEntityIdByScreenName(user, auth);

  if (!userIdRes.success) {
    throw userIdRes.err;
  }

  const { value: userId } = userIdRes;

  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxTweets) {
    const response = await fetchTweetsAndReplies(userId, maxTweets - totalFetched, cursor, auth);

    for (const tweet of response.tweets) {
      yield tweet;
      totalFetched++;
      if (totalFetched >= maxTweets) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getTweetsAndRepliesByUserId(
  userId: string,
  maxTweets: number,
  auth: TwitterAuth
): AsyncGenerator<Tweet, void> {
  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxTweets) {
    const response = await fetchTweetsAndReplies(userId, maxTweets - totalFetched, cursor, auth);

    for (const tweet of response.tweets) {
      yield tweet;
      totalFetched++;
      if (totalFetched >= maxTweets) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function fetchLikedTweets(
  userId: string,
  maxTweets: number,
  cursor: string | undefined,
  auth: TwitterAuth
): Promise<QueryTweetsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.userLikedTweets(userId, {
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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedTweets: Tweet[] = [];

    // Use the paginator's built-in methods to access data
    for await (const tweet of response) {
      convertedTweets.push(parseTweetV2ToV1(tweet, response.includes));
      if (convertedTweets.length >= maxTweets) break;
    }

    return {
      tweets: convertedTweets,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch liked tweets: ${message}`);
  }
}

export async function getTweetWhere(
  tweets: AsyncIterable<Tweet>,
  query: TweetQuery
): Promise<Tweet | null> {
  const isCallback = typeof query === "function";

  for await (const tweet of tweets) {
    const matches = isCallback ? await query(tweet) : checkTweetMatches(tweet, query);

    if (matches) {
      return tweet;
    }
  }

  return null;
}

export async function getTweetsWhere(
  tweets: AsyncIterable<Tweet>,
  query: TweetQuery
): Promise<Tweet[]> {
  const isCallback = typeof query === "function";
  const filtered = [];

  for await (const tweet of tweets) {
    const matches = isCallback ? query(tweet) : checkTweetMatches(tweet, query);

    if (!matches) continue;
    filtered.push(tweet);
  }

  return filtered;
}

function checkTweetMatches(tweet: Tweet, options: Partial<Tweet>): boolean {
  return Object.keys(options).every((k) => {
    const key = k as keyof Tweet;
    return tweet[key] === options[key];
  });
}

export async function getLatestTweet(
  user: string,
  includeRetweets: boolean,
  max: number,
  auth: TwitterAuth
): Promise<Tweet | null | undefined> {
  const timeline = getTweets(user, max, auth);

  // No point looping if max is 1, just use first entry.
  return max === 1
    ? ((await timeline.next()).value as Tweet)
    : await getTweetWhere(timeline, { isRetweet: includeRetweets });
}

// TweetResultByRestId interface removed - no longer used with v2 API

export async function getTweet(id: string, auth: TwitterAuth): Promise<Tweet | null> {
  const client = await auth.getV2Client();

  try {
    const tweet = await client.v2.singleTweet(id, {
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
      "poll.fields": ["id", "options", "end_datetime", "voting_status"],
      expansions: [
        "author_id",
        "attachments.media_keys",
        "attachments.poll_ids",
        "referenced_tweets.id",
      ],
    });

    if (!tweet.data) {
      return null;
    }

    return parseTweetV2ToV1(tweet.data, tweet.includes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get tweet: ${message}`);
    return null;
  }
}

export async function getTweetV2(
  id: string,
  auth: TwitterAuth,
  options: {
    expansions?: TTweetv2Expansion[];
    tweetFields?: TTweetv2TweetField[];
    pollFields?: TTweetv2PollField[];
    mediaFields?: TTweetv2MediaField[];
    userFields?: TTweetv2UserField[];
    placeFields?: TTweetv2PlaceField[];
  } = defaultOptions
): Promise<Tweet | null> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const tweetData = await v2client.v2.singleTweet(id, {
      expansions: options?.expansions,
      "tweet.fields": options?.tweetFields,
      "poll.fields": options?.pollFields,
      "media.fields": options?.mediaFields,
      "user.fields": options?.userFields,
      "place.fields": options?.placeFields,
    });

    if (!tweetData?.data) {
      console.warn(`Tweet data not found for ID: ${id}`);
      return null;
    }

    // Extract primary tweet data
    const parsedTweet = parseTweetV2ToV1(tweetData.data, tweetData?.includes);

    return parsedTweet;
  } catch (error) {
    console.error(`Error fetching tweet ${id}:`, error);
    return null;
  }
}

export async function getTweetsV2(
  ids: string[],
  auth: TwitterAuth,
  options: {
    expansions?: TTweetv2Expansion[];
    tweetFields?: TTweetv2TweetField[];
    pollFields?: TTweetv2PollField[];
    mediaFields?: TTweetv2MediaField[];
    userFields?: TTweetv2UserField[];
    placeFields?: TTweetv2PlaceField[];
  } = defaultOptions
): Promise<Tweet[]> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    return [];
  }

  try {
    const tweetData = await v2client.v2.tweets(ids, {
      expansions: options?.expansions,
      "tweet.fields": options?.tweetFields,
      "poll.fields": options?.pollFields,
      "media.fields": options?.mediaFields,
      "user.fields": options?.userFields,
      "place.fields": options?.placeFields,
    });
    const tweetsV2 = tweetData.data;
    if (tweetsV2.length === 0) {
      console.warn(`No tweet data found for IDs: ${ids.join(", ")}`);
      return [];
    }
    return (
      await Promise.all(tweetsV2.map(async (tweet) => await getTweetV2(tweet.id, auth, options)))
    ).filter((tweet): tweet is Tweet => tweet !== null);
  } catch (error) {
    console.error(`Error fetching tweets for IDs: ${ids.join(", ")}`, error);
    return [];
  }
}

export async function getTweetAnonymous(id: string, auth: TwitterAuth): Promise<Tweet | null> {
  // Twitter API v2 doesn't support anonymous access
  // Use the regular getTweet method
  return getTweet(id, auth);
}

async function _uploadMedia(
  _mediaData: Buffer,
  _auth: TwitterAuth,
  _mediaType: string
): Promise<string> {
  // Twitter API v2 media upload is not yet fully implemented in twitter-api-v2 library
  // This would require using the v1.1 media upload endpoint with proper OAuth
  console.warn("Media upload not yet implemented for Twitter API v2");
  throw new Error("Media upload not yet implemented for Twitter API v2");
}

// Function to create a quote tweet
export async function createQuoteTweetRequest(
  text: string,
  quotedTweetId: string,
  auth: TwitterAuth,
  _mediaData?: { data: Buffer; mediaType: string }[]
) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    // Quote tweets in v2 are created by including the tweet URL in the text
    const quotedTweetUrl = `https://twitter.com/i/status/${quotedTweetId}`;
    const fullText = `${text} ${quotedTweetUrl}`;

    const result = await v2client.v2.tweet({
      text: fullText,
    });

    return {
      ok: true,
      json: async () => result,
      data: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create quote tweet: ${message}`);
  }
}

/**
 * Likes a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to like.
 * @param auth The authentication object.
 * @returns A promise that resolves when the tweet is liked.
 */
export async function likeTweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.like(
      (await v2client.v2.me()).data.id, // Current user ID
      tweetId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to like tweet: ${message}`);
  }
}

/**
 * Retweets a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to retweet.
 * @param auth The authentication object.
 * @returns A promise that resolves when the tweet is retweeted.
 */
export async function retweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.retweet(
      (await v2client.v2.me()).data.id, // Current user ID
      tweetId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retweet: ${message}`);
  }
}

/**
 * Unlikes a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to unlike.
 * @param auth The authentication object.
 * @returns A promise that resolves when the tweet is unliked.
 */
export async function unlikeTweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.unlike(
      (await v2client.v2.me()).data.id, // Current user ID
      tweetId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unlike tweet: ${message}`);
  }
}

/**
 * Removes a retweet of a tweet with the given tweet ID.
 * @param tweetId The ID of the tweet to unretweet.
 * @param auth The authentication object.
 * @returns A promise that resolves when the retweet is removed.
 */
export async function unretweet(tweetId: string, auth: TwitterAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.unretweet(
      (await v2client.v2.me()).data.id, // Current user ID
      tweetId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unretweet: ${message}`);
  }
}

export async function createCreateLongTweetRequest(
  text: string,
  auth: TwitterAuth,
  tweetId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  // Twitter API v2 handles long tweets automatically
  // Just use the regular tweet creation endpoint
  return createCreateTweetRequest(text, auth, tweetId, mediaData);
}

// getArticle function removed - Twitter API v2 doesn't have a separate article endpoint

/**
 * Fetches a single page of retweeters for a given tweet, collecting both bottom and top cursors.
 * Logs each user's description in the process.
 * All comments must remain in English.
 */
export async function fetchRetweetersPage(
  _tweetId: string,
  _auth: TwitterAuth,
  _cursor?: string,
  _count = 40
): Promise<{
  retweeters: Retweeter[];
  bottomCursor?: string;
  topCursor?: string;
}> {
  // Twitter API v2 does not provide an endpoint to fetch retweeters
  // This functionality would require the API v2 retweeted_by endpoint
  console.warn("Fetching retweeters not implemented for Twitter API v2");
  return {
    retweeters: [],
    bottomCursor: undefined,
    topCursor: undefined,
  };
}

/**
 * Retrieves *all* retweeters by chaining requests until no next cursor is found.
 * @param tweetId The ID of the tweet.
 * @param auth The TwitterAuth object for authentication.
 * @returns A list of all users that retweeted the tweet.
 */
export async function getAllRetweeters(tweetId: string, auth: TwitterAuth): Promise<Retweeter[]> {
  let allRetweeters: Retweeter[] = [];
  let cursor: string | undefined;

  while (true) {
    // Destructure bottomCursor / topCursor
    const { retweeters, bottomCursor, topCursor } = await fetchRetweetersPage(
      tweetId,
      auth,
      cursor,
      40
    );
    allRetweeters = allRetweeters.concat(retweeters);

    const newCursor = bottomCursor || topCursor;

    // Stop if there is no new cursor or if it's the same as the old one
    if (!newCursor || newCursor === cursor) {
      break;
    }

    cursor = newCursor;
  }

  return allRetweeters;
}

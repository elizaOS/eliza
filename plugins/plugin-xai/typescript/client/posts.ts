import type {
  ApiV2Includes,
  MediaObjectV2,
  PlaceV2,
  PollV2,
  ReferencedTweetV2,
  TTweetv2Expansion,
  TTweetv2MediaField,
  TTweetv2PlaceField,
  TTweetv2PollField,
  TTweetv2TweetField,
  TTweetv2UserField,
  TweetEntityHashtagV2,
  TweetEntityMentionV2,
  TweetEntityUrlV2,
  TweetV2,
  UserV2,
} from "twitter-api-v2";
import type { XAuth } from "./auth";
import { getEntityIdByScreenName } from "./profile";
import type { QueryPostsResponse } from "./types";

// Type aliases for X naming convention
type PostV2 = TweetV2;
type TPostv2Expansion = TTweetv2Expansion;
type TPostv2MediaField = TTweetv2MediaField;
type TPostv2PlaceField = TTweetv2PlaceField;
type TPostv2PollField = TTweetv2PollField;
type TPostv2PostField = TTweetv2TweetField;
type TPostv2UserField = TTweetv2UserField;

/**
 * Default options for X API v2 request parameters.
 * @typedef {Object} defaultOptions
 * @property {TPostv2Expansion[]} expansions - List of expansions to include in the request.
 * @property {TPostv2PostField[]} postFields - List of post fields to include in the request.
 * @property {TPostv2PollField[]} pollFields - List of poll fields to include in the request.
 * @property {TPostv2MediaField[]} mediaFields - List of media fields to include in the request.
 * @property {TPostv2UserField[]} userFields - List of user fields to include in the request.
 * @property {TPostv2PlaceField[]} placeFields - List of place fields to include in the request.
 */
export const defaultOptions = {
  expansions: [
    "attachments.poll_ids",
    "attachments.media_keys",
    "author_id",
    "referenced_tweets.id",
    "in_reply_to_user_id",
    "edit_history_post_ids",
    "geo.place_id",
    "entities.mentions.username",
    "referenced_tweets.id.author_id",
  ] as TPostv2Expansion[],
  postFields: [
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
    "note_post",
  ] as TPostv2PostField[],
  pollFields: [
    "duration_minutes",
    "end_datetime",
    "id",
    "options",
    "voting_status",
  ] as TPostv2PollField[],
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
  ] as TPostv2MediaField[],
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
  ] as TPostv2UserField[],
  placeFields: [
    "contained_within",
    "country",
    "country_code",
    "full_name",
    "geo",
    "id",
    "name",
    "place_type",
  ] as TPostv2PlaceField[],
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
 * A parsed Post object.
 */
/**
 * Represents a Post on X.
 * @typedef { Object } Post
 * @property { number } [bookmarkCount] - The number of times this Post has been bookmarked.
 * @property { string } [conversationId] - The ID of the conversation this Post is a part of.
 * @property {string[]} hashtags - An array of hashtags mentioned in the Post.
 * @property { string } [html] - The HTML content of the Post.
 * @property { string } [id] - The unique ID of the Post.
 * @property { Post } [inReplyToStatus] - The Post that this Post is in reply to.
 * @property { string } [inReplyToStatusId] - The ID of the Post that this Post is in reply to.
 * @property { boolean } [isQuoted] - Indicates if this Post is a quote of another Post.
 * @property { boolean } [isPin] - Indicates if this Post is pinned.
 * @property { boolean } [isReply] - Indicates if this Post is a reply to another Post.
 * @property { boolean } [isRepost] - Indicates if this Post is a repost.
 * @property { boolean } [isSelfThread] - Indicates if this Post is part of a self thread.
 * @property { string } [language] - The language of the Post.
 * @property { number } [likes] - The number of likes on the Post.
 * @property { string } [name] - The name associated with the Post.
 * @property {Mention[]} mentions - An array of mentions in the Post.
 * @property { string } [permanentUrl] - The permanent URL of the Post.
 * @property {Photo[]} photos - An array of photos attached to the Post.
 * @property { PlaceRaw } [place] - The place associated with the Post.
 * @property { Post } [quotedStatus] - The quoted Post.
 * @property { string } [quotedStatusId] - The ID of the quoted Post.
 * @property { number } [quotes] - The number of times this Post has been quoted.
 * @property { number } [replies] - The number of replies to the Post.
 * @property { number } [reposts] - The number of reposts on the Post.
 * @property { Post } [repostedStatus] - The status that was reposted.
 * @property { string } [repostedStatusId] - The ID of the reposted status.
 * @property { string } [text] - The text content of the Post.
 * @property {Post[]} thread - An array representing an X thread.
 * @property { Date } [timeParsed] - The parsed timestamp of the Post.
 * @property { number } [timestamp] - The timestamp of the Post.
 * @property {string[]} urls - An array of URLs mentioned in the Post.
 * @property { string } [userId] - The ID of the user who posted the Post.
 * @property { string } [username] - The username of the user who posted the Post.
 * @property {Video[]} videos - An array of videos attached to the Post.
 * @property { number } [views] - The number of views on the Post.
 * @property { boolean } [sensitiveContent] - Indicates if the Post contains sensitive content.
 * @property {PollV2 | null} [poll] - The poll attached to the Post, if any.
 */
export interface Post {
  bookmarkCount?: number;
  conversationId?: string;
  hashtags: string[];
  html?: string;
  id?: string;
  inReplyToStatus?: Post;
  inReplyToStatusId?: string;
  isQuoted?: boolean;
  isPin?: boolean;
  isReply?: boolean;
  isRepost?: boolean;
  isSelfThread?: boolean;
  language?: string;
  likes?: number;
  name?: string;
  mentions: Mention[];
  permanentUrl?: string;
  photos: Photo[];
  place?: PlaceRaw;
  quotedStatus?: Post;
  quotedStatusId?: string;
  quotes?: number;
  replies?: number;
  reposts?: number;
  repostedStatus?: Post;
  repostedStatusId?: string;
  text?: string;
  thread: Post[];
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

export interface Reposter {
  rest_id: string;
  screen_name: string;
  name: string;
  description?: string;
}

export type PostQuery = Partial<Post> | ((post: Post) => boolean | Promise<boolean>);

export async function fetchPosts(
  userId: string,
  maxPosts: number,
  cursor: string | undefined,
  auth: XAuth
): Promise<QueryPostsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.userTimeline(userId, {
      max_results: Math.min(maxPosts, 100),
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

    const convertedPosts: Post[] = [];

    // Use the paginator's built-in methods to access data
    for await (const post of response) {
      convertedPosts.push(parsePostV2ToV1(post, response.includes));
      if (convertedPosts.length >= maxPosts) break;
    }

    return {
      posts: convertedPosts,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch posts: ${message}`);
  }
}

export async function fetchPostsAndReplies(
  userId: string,
  maxPosts: number,
  cursor: string | undefined,
  auth: XAuth
): Promise<QueryPostsResponse> {
  const client = await auth.getV2Client();

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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedPosts: Post[] = [];

    // Use the paginator's built-in methods to access data
    for await (const post of response) {
      convertedPosts.push(parsePostV2ToV1(post, response.includes));
      if (convertedPosts.length >= maxPosts) break;
    }

    return {
      posts: convertedPosts,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch posts and replies: ${message}`);
  }
}

export async function createCreatePostRequestV2(
  text: string,
  auth: XAuth,
  postId?: string,
  options?: {
    poll?: PollData;
  }
) {
  const v2client = await auth.getV2Client();
  if (v2client == null) {
    throw new Error("V2 client is not initialized");
  }
  const { poll } = options || {};
  let postConfig: {
    text: string;
    poll?: { options: string[]; duration_minutes: number };
    reply?: { in_reply_to_tweet_id: string };
  };
  if (poll) {
    postConfig = {
      text,
      poll: {
        options: poll?.options.map((option) => option.label) ?? [],
        duration_minutes: poll?.duration_minutes ?? 60,
      },
    };
  } else if (postId) {
    postConfig = {
      text,
      reply: {
        in_reply_to_tweet_id: postId,
      },
    };
  } else {
    postConfig = {
      text,
    };
  }
  const postResponse = await v2client.v2.tweet(postConfig);
  let optionsConfig = {};
  if (options?.poll) {
    optionsConfig = {
      expansions: ["attachments.poll_ids"],
      pollFields: ["options", "duration_minutes", "end_datetime", "voting_status"],
    };
  }
  return await getPostV2(postResponse.data.id, auth, optionsConfig);
}

export function parsePostV2ToV1(postV2: PostV2, includes?: ApiV2Includes): Post {
  const parsedPost: Post = {
    id: postV2.id,
    text: postV2.text ?? "",
    hashtags: postV2.entities?.hashtags?.map((tag: TweetEntityHashtagV2) => tag.tag) ?? [],
    mentions:
      postV2.entities?.mentions?.map((mention: TweetEntityMentionV2) => ({
        id: mention.id,
        username: mention.username,
      })) ?? [],
    urls: postV2.entities?.urls?.map((url: TweetEntityUrlV2) => url.url) ?? [],
    likes: postV2.public_metrics?.like_count ?? 0,
    reposts: postV2.public_metrics?.retweet_count ?? 0,
    replies: postV2.public_metrics?.reply_count ?? 0,
    quotes: postV2.public_metrics?.quote_count ?? 0,
    views: postV2.public_metrics?.impression_count ?? 0,
    userId: postV2.author_id,
    conversationId: postV2.conversation_id,
    photos: [],
    videos: [],
    poll: null,
    username: "",
    name: "",
    thread: [],
    timestamp: postV2.created_at ? new Date(postV2.created_at).getTime() / 1000 : Date.now() / 1000,
    permanentUrl: `https://x.com/i/status/${postV2.id}`,
    // Check for referenced posts
    isReply:
      postV2.referenced_tweets?.some((ref: ReferencedTweetV2) => ref.type === "replied_to") ??
      false,
    isRepost:
      postV2.referenced_tweets?.some((ref: ReferencedTweetV2) => ref.type === "retweeted") ?? false,
    isQuoted:
      postV2.referenced_tweets?.some((ref: ReferencedTweetV2) => ref.type === "quoted") ?? false,
    inReplyToStatusId: postV2.referenced_tweets?.find(
      (ref: ReferencedTweetV2) => ref.type === "replied_to"
    )?.id,
    quotedStatusId: postV2.referenced_tweets?.find(
      (ref: ReferencedTweetV2) => ref.type === "quoted"
    )?.id,
    repostedStatusId: postV2.referenced_tweets?.find(
      (ref: ReferencedTweetV2) => ref.type === "retweeted"
    )?.id,
  };

  // Process Polls
  if (includes?.polls?.length) {
    const poll = includes.polls[0];
    parsedPost.poll = {
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
        parsedPost.photos.push({
          id: media.media_key,
          url: media.url ?? "",
          alt_text: media.alt_text ?? "",
        });
      } else if (media.type === "video" || media.type === "animated_gif") {
        parsedPost.videos.push({
          id: media.media_key,
          preview: media.preview_image_url ?? "",
          url: media.variants?.find((variant) => variant.content_type === "video/mp4")?.url ?? "",
        });
      }
    });
  }

  // Process User (for author info)
  if (includes?.users?.length) {
    const user = includes.users.find((user: UserV2) => user.id === postV2.author_id);
    if (user) {
      parsedPost.username = user.username ?? "";
      parsedPost.name = user.name ?? "";
    }
  }

  // Process Place (if any)
  if (postV2?.geo?.place_id && includes?.places?.length) {
    const place = includes.places.find((place: PlaceV2) => place.id === postV2?.geo?.place_id);
    if (place) {
      parsedPost.place = {
        id: place.id,
        full_name: place.full_name ?? "",
        country: place.country ?? "",
        country_code: place.country_code ?? "",
        name: place.name ?? "",
        place_type: place.place_type,
      };
    }
  }

  return parsedPost;
}

export async function createCreatePostRequest(
  text: string,
  auth: XAuth,
  postId?: string,
  mediaData?: { data: Buffer; mediaType: string }[],
  _hideLinkPreview = false
) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const postConfig: {
      text: string;
      reply?: { in_reply_to_tweet_id: string };
      poll?: { options: string[]; duration_minutes: number };
    } = {
      text,
    };

    // Handle media uploads if provided
    if (mediaData && mediaData.length > 0) {
      console.warn("Media upload requires X API v1.1 Media Upload endpoint");
    }

    // Handle reply
    if (postId) {
      postConfig.reply = {
        in_reply_to_tweet_id: postId,
      };
    }

    const result = await v2client.v2.tweet(postConfig);

    return {
      ok: true,
      json: async () => result,
      data: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create post: ${message}`);
  }
}

export async function createCreateNotePostRequest(
  text: string,
  auth: XAuth,
  postId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  // X API v2 doesn't have a separate endpoint for "note posts"
  // Long posts are handled automatically by the v2 post endpoint
  return createCreatePostRequest(text, auth, postId, mediaData);
}

export async function fetchListPosts(
  listId: string,
  maxPosts: number,
  cursor: string | undefined,
  auth: XAuth
): Promise<QueryPostsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.listTweets(listId, {
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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedPosts: Post[] = [];

    // Use the paginator's built-in methods to access data
    for await (const post of response) {
      convertedPosts.push(parsePostV2ToV1(post, response.includes));
      if (convertedPosts.length >= maxPosts) break;
    }

    return {
      posts: convertedPosts,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch list posts: ${message}`);
  }
}

export async function deletePost(postId: string, auth: XAuth) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const result = await v2client.v2.deleteTweet(postId);
    return {
      ok: true,
      success: true,
      json: async () => result,
      data: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete post: ${message}`);
  }
}

export async function* getPosts(
  user: string,
  maxPosts: number,
  auth: XAuth
): AsyncGenerator<Post, void> {
  const userIdRes = await getEntityIdByScreenName(user, auth);

  if (!userIdRes.success) {
    throw userIdRes.err;
  }

  const { value: userId } = userIdRes;

  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxPosts) {
    const response = await fetchPosts(userId, maxPosts - totalFetched, cursor, auth);

    for (const post of response.posts) {
      yield post;
      totalFetched++;
      if (totalFetched >= maxPosts) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getPostsByUserId(
  userId: string,
  maxPosts: number,
  auth: XAuth
): AsyncGenerator<Post, void> {
  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxPosts) {
    const response = await fetchPosts(userId, maxPosts - totalFetched, cursor, auth);

    for (const post of response.posts) {
      yield post;
      totalFetched++;
      if (totalFetched >= maxPosts) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getPostsAndReplies(
  user: string,
  maxPosts: number,
  auth: XAuth
): AsyncGenerator<Post, void> {
  const userIdRes = await getEntityIdByScreenName(user, auth);

  if (!userIdRes.success) {
    throw userIdRes.err;
  }

  const { value: userId } = userIdRes;

  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxPosts) {
    const response = await fetchPostsAndReplies(userId, maxPosts - totalFetched, cursor, auth);

    for (const post of response.posts) {
      yield post;
      totalFetched++;
      if (totalFetched >= maxPosts) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function* getPostsAndRepliesByUserId(
  userId: string,
  maxPosts: number,
  auth: XAuth
): AsyncGenerator<Post, void> {
  let cursor: string | undefined;
  let totalFetched = 0;

  while (totalFetched < maxPosts) {
    const response = await fetchPostsAndReplies(userId, maxPosts - totalFetched, cursor, auth);

    for (const post of response.posts) {
      yield post;
      totalFetched++;
      if (totalFetched >= maxPosts) break;
    }

    cursor = response.next;
    if (!cursor) break;
  }
}

export async function fetchLikedPosts(
  userId: string,
  maxPosts: number,
  cursor: string | undefined,
  auth: XAuth
): Promise<QueryPostsResponse> {
  const client = await auth.getV2Client();

  try {
    const response = await client.v2.userLikedTweets(userId, {
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
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
      pagination_token: cursor,
    });

    const convertedPosts: Post[] = [];

    // Use the paginator's built-in methods to access data
    for await (const post of response) {
      convertedPosts.push(parsePostV2ToV1(post, response.includes));
      if (convertedPosts.length >= maxPosts) break;
    }

    return {
      posts: convertedPosts,
      next: response.meta.next_token,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch liked posts: ${message}`);
  }
}

export async function getPostWhere(
  posts: AsyncIterable<Post>,
  query: PostQuery
): Promise<Post | null> {
  const isCallback = typeof query === "function";

  for await (const post of posts) {
    const matches = isCallback ? await query(post) : checkPostMatches(post, query);

    if (matches) {
      return post;
    }
  }

  return null;
}

export async function getPostsWhere(posts: AsyncIterable<Post>, query: PostQuery): Promise<Post[]> {
  const isCallback = typeof query === "function";
  const filtered = [];

  for await (const post of posts) {
    const matches = isCallback ? query(post) : checkPostMatches(post, query);

    if (!matches) continue;
    filtered.push(post);
  }

  return filtered;
}

function checkPostMatches(post: Post, options: Partial<Post>): boolean {
  return Object.keys(options).every((k) => {
    const key = k as keyof Post;
    return post[key] === options[key];
  });
}

export async function getLatestPost(
  user: string,
  includeReposts: boolean,
  max: number,
  auth: XAuth
): Promise<Post | null | undefined> {
  const timeline = getPosts(user, max, auth);

  // No point looping if max is 1, just use first entry.
  return max === 1
    ? ((await timeline.next()).value as Post)
    : await getPostWhere(timeline, { isRepost: includeReposts });
}

// PostResultByRestId interface removed - no longer used with v2 API

export async function getPost(id: string, auth: XAuth): Promise<Post | null> {
  const client = await auth.getV2Client();

  try {
    const post = await client.v2.singleTweet(id, {
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

    if (!post.data) {
      return null;
    }

    return parsePostV2ToV1(post.data, post.includes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get post: ${message}`);
    return null;
  }
}

export async function getPostV2(
  id: string,
  auth: XAuth,
  options: {
    expansions?: TPostv2Expansion[];
    postFields?: TPostv2PostField[];
    pollFields?: TPostv2PollField[];
    mediaFields?: TPostv2MediaField[];
    userFields?: TPostv2UserField[];
    placeFields?: TPostv2PlaceField[];
  } = defaultOptions
): Promise<Post | null> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    const postData = await v2client.v2.singleTweet(id, {
      expansions: options?.expansions,
      "tweet.fields": options?.postFields,
      "poll.fields": options?.pollFields,
      "media.fields": options?.mediaFields,
      "user.fields": options?.userFields,
      "place.fields": options?.placeFields,
    });

    if (!postData?.data) {
      console.warn(`Post data not found for ID: ${id}`);
      return null;
    }

    // Extract primary post data
    const parsedPost = parsePostV2ToV1(postData.data, postData?.includes);

    return parsedPost;
  } catch (error) {
    console.error(`Error fetching post ${id}:`, error);
    return null;
  }
}

export async function getPostsV2(
  ids: string[],
  auth: XAuth,
  options: {
    expansions?: TPostv2Expansion[];
    postFields?: TPostv2PostField[];
    pollFields?: TPostv2PollField[];
    mediaFields?: TPostv2MediaField[];
    userFields?: TPostv2UserField[];
    placeFields?: TPostv2PlaceField[];
  } = defaultOptions
): Promise<Post[]> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    return [];
  }

  try {
    const postData = await v2client.v2.tweets(ids, {
      expansions: options?.expansions,
      "tweet.fields": options?.postFields,
      "poll.fields": options?.pollFields,
      "media.fields": options?.mediaFields,
      "user.fields": options?.userFields,
      "place.fields": options?.placeFields,
    });
    const postsV2 = postData.data;
    if (postsV2.length === 0) {
      console.warn(`No post data found for IDs: ${ids.join(", ")}`);
      return [];
    }
    return (
      await Promise.all(postsV2.map(async (post) => await getPostV2(post.id, auth, options)))
    ).filter((post): post is Post => post !== null);
  } catch (error) {
    console.error(`Error fetching posts for IDs: ${ids.join(", ")}`, error);
    return [];
  }
}

export async function getPostAnonymous(id: string, auth: XAuth): Promise<Post | null> {
  // X API v2 doesn't support anonymous access
  // Use the regular getPost method
  return getPost(id, auth);
}

async function _uploadMedia(_mediaData: Buffer, _auth: XAuth, _mediaType: string): Promise<string> {
  // X API v2 media upload is not yet fully implemented in twitter-api-v2 library
  // This would require using the v1.1 media upload endpoint with proper OAuth
  console.warn("Media upload not yet implemented for X API v2");
  throw new Error("Media upload not yet implemented for X API v2");
}

// Function to create a quote post
export async function createQuotePostRequest(
  text: string,
  quotedPostId: string,
  auth: XAuth,
  _mediaData?: { data: Buffer; mediaType: string }[]
) {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    // Quote posts in v2 are created by including the post URL in the text
    const quotedPostUrl = `https://x.com/i/status/${quotedPostId}`;
    const fullText = `${text} ${quotedPostUrl}`;

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
    throw new Error(`Failed to create quote post: ${message}`);
  }
}

/**
 * Likes a post with the given post ID.
 * @param postId The ID of the post to like.
 * @param auth The authentication object.
 * @returns A promise that resolves when the post is liked.
 */
export async function likePost(postId: string, auth: XAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.like(
      (await v2client.v2.me()).data.id, // Current user ID
      postId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to like post: ${message}`);
  }
}

/**
 * Reposts a post with the given post ID.
 * @param postId The ID of the post to repost.
 * @param auth The authentication object.
 * @returns A promise that resolves when the post is reposted.
 */
export async function repost(postId: string, auth: XAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.retweet(
      (await v2client.v2.me()).data.id, // Current user ID
      postId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to repost: ${message}`);
  }
}

/**
 * Unlikes a post with the given post ID.
 * @param postId The ID of the post to unlike.
 * @param auth The authentication object.
 * @returns A promise that resolves when the post is unliked.
 */
export async function unlikePost(postId: string, auth: XAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.unlike(
      (await v2client.v2.me()).data.id, // Current user ID
      postId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unlike post: ${message}`);
  }
}

/**
 * Removes a repost of a post with the given post ID.
 * @param postId The ID of the post to unrepost.
 * @param auth The authentication object.
 * @returns A promise that resolves when the repost is removed.
 */
export async function unrepost(postId: string, auth: XAuth): Promise<void> {
  const v2client = await auth.getV2Client();
  if (!v2client) {
    throw new Error("V2 client is not initialized");
  }

  try {
    await v2client.v2.unretweet(
      (await v2client.v2.me()).data.id, // Current user ID
      postId
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to unrepost: ${message}`);
  }
}

export async function createCreateLongPostRequest(
  text: string,
  auth: XAuth,
  postId?: string,
  mediaData?: { data: Buffer; mediaType: string }[]
) {
  // X API v2 handles long posts automatically
  // Just use the regular post creation endpoint
  return createCreatePostRequest(text, auth, postId, mediaData);
}

// getArticle function removed - X API v2 doesn't have a separate article endpoint

/**
 * Fetches a single page of reposters for a given post, collecting both bottom and top cursors.
 * Logs each user's description in the process.
 * All comments must remain in English.
 */
export async function fetchRepostersPage(
  _postId: string,
  _auth: XAuth,
  _cursor?: string,
  _count = 40
): Promise<{
  reposters: Reposter[];
  bottomCursor?: string;
  topCursor?: string;
}> {
  // X API v2 does not provide an endpoint to fetch reposters
  // This functionality would require the API v2 reposted_by endpoint
  console.warn("Fetching reposters not implemented for X API v2");
  return {
    reposters: [],
    bottomCursor: undefined,
    topCursor: undefined,
  };
}

/**
 * Retrieves *all* reposters by chaining requests until no next cursor is found.
 * @param postId The ID of the post.
 * @param auth The XAuth object for authentication.
 * @returns A list of all users that reposted the post.
 */
export async function getAllReposters(postId: string, auth: XAuth): Promise<Reposter[]> {
  let allReposters: Reposter[] = [];
  let cursor: string | undefined;

  while (true) {
    // Destructure bottomCursor / topCursor
    const { reposters, bottomCursor, topCursor } = await fetchRepostersPage(
      postId,
      auth,
      cursor,
      40
    );
    allReposters = allReposters.concat(reposters);

    const newCursor = bottomCursor || topCursor;

    // Stop if there is no new cursor or if it's the same as the old one
    if (!newCursor || newCursor === cursor) {
      break;
    }

    cursor = newCursor;
  }

  return allReposters;
}

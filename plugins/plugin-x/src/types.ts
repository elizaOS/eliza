import type {
  EventPayload,
  HandlerCallback,
  Memory,
  MessagePayload,
  UUID,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { Tweet as ClientTweet, Mention } from "./client/tweets";
import type { TwitterConfig } from "./environment";
import type { TwitterInteractionClient } from "./interactions";
import type { TwitterPostClient } from "./post";

/**
 * Runtime-provided state passed into the Twitter client constructors.
 *
 * In practice this is either an empty object (when the runtime holds all
 * settings), a subset of {@link TwitterConfig}, or an account-scoped state
 * resolved by the plugin-local X account resolver. We intentionally do not add
 * an index signature here: extra, unknown keys should be pushed into runtime
 * settings or the connector account store rather than carried on `state`.
 */
export type TwitterClientState = Partial<TwitterConfig> & {
  /**
   * Connector account identifier this client instance is bound to. Defaults
   * to "default" in single-account mode; resolved via the connector account
   * manager or the plugin-local resolver otherwise.
   */
  accountId?: string;
};

/**
 * Defines a type for media data, which includes a Buffer representing the actual data
 * and a mediaType string indicating the type of media.
 *
 * @typedef {Object} MediaData
 * @property {Buffer} data - The Buffer representing the actual media data.
 * @property {string} mediaType - The type of media (e.g. image, video).
 */
export type MediaData = {
  data: Buffer;
  mediaType: string;
};

/**
 * Interface representing the response from an action.
 * @typedef {Object} ActionResponse
 * @property {boolean} like - Indicates if the action is a like.
 * @property {boolean} retweet - Indicates if the action is a retweet.
 * @property {boolean=} quote - Indicates if the action is a quote. (optional)
 * @property {boolean=} reply - Indicates if the action is a reply. (optional)
 */
export interface ActionResponse {
  like: boolean;
  retweet: boolean;
  quote?: boolean;
  reply?: boolean;
}

/**
 * @interface ITwitterClient
 * Represents the main Twitter client interface for interacting with Twitter's API.
 * @property {ClientBase} client - The base client for Twitter operations.
 * @property {TwitterPostClient} post - The client for managing Twitter posts.
 * @property {TwitterInteractionClient} interaction - The client for managing Twitter interactions.
 */
export interface ITwitterClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
}

/**
 * Twitter-specific tweet type
 */
export type Tweet = {
  id: string;
  text: string;
  userId: string;
  username: string;
  name: string;
  conversationId: string;
  inReplyToStatusId?: string;
  timestamp: number;
  photos: { url: string }[];
  mentions: string[];
  hashtags: string[];
  urls: string[];
  videos: ClientTweet["videos"];
  thread: ClientTweet["thread"];
  permanentUrl: string;
};

/**
 * Convert client tweet to core tweet
 */
export function convertClientTweetToCoreTweet(tweet: ClientTweet): Tweet {
  const mentions = Array.isArray(tweet.mentions)
    ? tweet.mentions
        .filter(
          (mention): mention is Mention & { username: string } =>
            typeof mention === "object" &&
            mention !== null &&
            typeof mention.username === "string",
        )
        .map((mention) => mention.username)
    : [];

  const hashtags = Array.isArray(tweet.hashtags)
    ? tweet.hashtags
        .filter((tag) => tag !== null && typeof tag === "object")
        .map((tag) => {
          const tagObj = tag as { text?: string };
          return typeof tagObj.text === "string" ? tagObj.text : "";
        })
        .filter((text): text is string => text !== "")
    : [];

  const urls = Array.isArray(tweet.urls)
    ? tweet.urls
        .filter((url) => url !== null && typeof url === "object")
        .map((url) => {
          const urlObj = url as { expanded_url?: string };
          return typeof urlObj.expanded_url === "string"
            ? urlObj.expanded_url
            : "";
        })
        .filter((url): url is string => url !== "")
    : [];

  return {
    id: tweet.id || "",
    text: tweet.text || "",
    userId: tweet.userId || "",
    username: tweet.username || "",
    name: tweet.name || "",
    conversationId: tweet.conversationId || "",
    inReplyToStatusId: tweet.inReplyToStatusId,
    timestamp: tweet.timestamp || 0,
    photos: tweet.photos || [],
    mentions,
    hashtags,
    urls,
    videos: tweet.videos || [],
    thread: tweet.thread || [],
    permanentUrl: tweet.permanentUrl || "",
  };
}

/**
 * Twitter-specific event types
 */
export enum TwitterEventTypes {
  // Reaction events
  LIKE_RECEIVED = "TWITTER_LIKE_RECEIVED",
  RETWEET_RECEIVED = "TWITTER_RETWEET_RECEIVED",
  QUOTE_RECEIVED = "TWITTER_QUOTE_RECEIVED",

  // Thread events
  THREAD_CREATED = "TWITTER_THREAD_CREATED",
  THREAD_UPDATED = "TWITTER_THREAD_UPDATED",
}

/**
 * Twitter-specific memory interface
 */
export interface TwitterMemory extends Memory {
  content: Memory["content"] & {
    source: "twitter";
    text?: string;
    type?: string;
    targetId?: string;
  };
  roomId: UUID;
}

/**
 * Minimum surface we rely on for Twitter user references attached to payloads.
 * The upstream Twitter API returns many more fields; consumers should narrow as
 * needed. Unknown extras are tolerated so we don't lose information.
 */
interface TwitterUserRef {
  id: string;
  username: string;
  name?: string;
  readonly [extra: string]: unknown;
}

/**
 * Twitter-specific quote tweet received payload
 */
export interface TwitterQuoteReceivedPayload
  extends Omit<MessagePayload, "message" | "reaction"> {
  /** The original tweet that was quoted */
  quotedTweet: Tweet;
  /** The quote tweet */
  quoteTweet: Tweet;
  /** The user who quoted */
  user: TwitterUserRef;
  /** The message being reacted to */
  message: TwitterMemory;
  /** Callback for handling the reaction */
  callback: HandlerCallback;
  /** The reaction details */
  reaction: {
    type: "quote";
    entityId: UUID;
  };
}


/**
 * Twitter-specific interaction memory
 */
export interface TwitterInteractionMemory extends TwitterMemory {
  content: {
    type: string;
    source: "twitter";
    targetId?: string;
  };
}

/**
 * Twitter-specific interaction payload
 */
export interface TwitterInteractionPayload {
  id: string;
  type: "like" | "retweet" | "quote";
  userId: string;
  username: string;
  name: string;
  targetTweetId: string;
  targetTweet: Tweet;
  quoteTweet?: Tweet;
  retweetId?: string;
}

/**
 * Twitter-specific like received payload
 */
export interface TwitterLikeReceivedPayload extends EventPayload {
  tweet: Tweet;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "twitter";
}

/**
 * Twitter-specific retweet received payload
 */
export interface TwitterRetweetReceivedPayload extends EventPayload {
  tweet: Tweet;
  retweetId: string;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "twitter";
}

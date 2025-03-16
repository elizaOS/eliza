import type {
  EntityPayload,
  EventPayload,
  HandlerCallback,
  Memory,
  MessagePayload,
  UUID,
  WorldPayload,
} from '@elizaos/core';
import type { TwitterService } from '.';
import type { ClientBase } from './base';
import type { Tweet as ClientTweet, Mention } from './client/tweets';
import type { TwitterInteractionClient } from './interactions';
import type { TwitterPostClient } from './post';
import type { TwitterSpaceClient } from './spaces';

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
 * Interface for a Twitter client.
 *
 * @property {ClientBase} client - The base client for making requests.
 * @property {TwitterPostClient} post - The client for posting on Twitter.
 * @property {TwitterInteractionClient} interaction - The client for interacting with tweets.
 * @property {TwitterSpaceClient} [space] - The client for managing Twitter spaces (optional).
 * @property {TwitterService} service - The service provider for Twitter API.
 */
export interface ITwitterClient {
  client: ClientBase;
  post: TwitterPostClient;
  interaction: TwitterInteractionClient;
  space?: TwitterSpaceClient;
  service: TwitterService;
}

export const ServiceType = {
  TWITTER: 'twitter',
} as const;

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
  videos: any[];
  thread: any[];
  permanentUrl: string;
};

/**
 * Convert client tweet to core tweet
 */
export function convertClientTweetToCoreTweet(tweet: ClientTweet): Tweet {
  const mentions = Array.isArray(tweet.mentions)
    ? tweet.mentions
        .filter(
          (mention): mention is Mention =>
            typeof mention === 'object' && mention !== null && typeof mention.username === 'string'
        )
        .map((mention) => mention.username)
    : [];

  const hashtags = Array.isArray(tweet.hashtags)
    ? tweet.hashtags
        .filter((tag) => tag !== null && typeof tag === 'object')
        .map((tag) => {
          const tagObj = tag as { text?: string };
          return typeof tagObj.text === 'string' ? tagObj.text : '';
        })
        .filter((text) => text !== '')
    : [];

  const urls = Array.isArray(tweet.urls)
    ? tweet.urls
        .filter((url) => url !== null && typeof url === 'object')
        .map((url) => {
          const urlObj = url as { expanded_url?: string };
          return typeof urlObj.expanded_url === 'string' ? urlObj.expanded_url : '';
        })
        .filter((url) => url !== '')
    : [];

  return {
    id: tweet.id || '',
    text: tweet.text || '',
    userId: tweet.userId || '',
    username: tweet.username || '',
    name: tweet.name || '',
    conversationId: tweet.conversationId || '',
    inReplyToStatusId: tweet.inReplyToStatusId,
    timestamp: tweet.timestamp || 0,
    photos: tweet.photos || [],
    mentions,
    hashtags,
    urls,
    videos: tweet.videos || [],
    thread: tweet.thread || [],
    permanentUrl: tweet.permanentUrl || '',
  };
}

export interface QueryTweetsResponse {
  tweets: Tweet[];
  cursor?: string;
}

/**
 * Twitter-specific event types
 */
export enum TwitterEventTypes {
  // Message (interaction) events
  MESSAGE_RECEIVED = 'TWITTER_MESSAGE_RECEIVED',
  MESSAGE_SENT = 'TWITTER_MESSAGE_SENT',

  // Post events
  POST_GENERATED = 'TWITTER_POST_GENERATED',
  POST_SENT = 'TWITTER_POST_SENT',

  // Reaction events
  REACTION_RECEIVED = 'TWITTER_REACTION_RECEIVED',
  LIKE_RECEIVED = 'TWITTER_LIKE_RECEIVED',
  RETWEET_RECEIVED = 'TWITTER_RETWEET_RECEIVED',
  QUOTE_RECEIVED = 'TWITTER_QUOTE_RECEIVED',

  // Server events
  WORLD_JOINED = 'TWITTER_WORLD_JOINED',

  // User events
  ENTITY_JOINED = 'TWITTER_USER_JOINED',
  ENTITY_LEFT = 'TWITTER_USER_LEFT',
  USER_FOLLOWED = 'TWITTER_USER_FOLLOWED',
  USER_UNFOLLOWED = 'TWITTER_USER_UNFOLLOWED',

  // Thread events
  THREAD_CREATED = 'TWITTER_THREAD_CREATED',
  THREAD_UPDATED = 'TWITTER_THREAD_UPDATED',

  // Mention events
  MENTION_RECEIVED = 'TWITTER_MENTION_RECEIVED',
}

/**
 * Twitter-specific memory interface
 */
export interface TwitterMemory extends Memory {
  content: {
    source: 'twitter';
    text?: string;
    type?: string;
    targetId?: string;
    [key: string]: any;
  };
  roomId: UUID;
}

/**
 * Twitter-specific message received payload
 */
export interface TwitterMessageReceivedPayload extends Omit<MessagePayload, 'message'> {
  message: TwitterMemory;
  tweet: Tweet;
  user: any;
}

/**
 * Twitter-specific message sent payload (for replies)
 */
export interface TwitterMessageSentPayload extends MessagePayload {
  /** The tweet ID that was replied to */
  inReplyToTweetId: string;
  /** The tweet result from Twitter API */
  tweetResult: any;
}

/**
 * Twitter-specific post generated payload
 */
export interface TwitterPostGeneratedPayload extends MessagePayload {
  /** The tweet result from Twitter API */
  tweetResult: any;
}

/**
 * Twitter-specific post sent payload
 */
export interface TwitterPostSentPayload extends MessagePayload {
  /** The tweet result from Twitter API */
  tweetResult: any;
}

/**
 * Twitter-specific reaction received payload
 */
export interface TwitterReactionReceivedPayload extends MessagePayload {
  /** The tweet that was reacted to */
  tweet: Tweet;
  /** The reaction type (like, retweet) */
  reactionType: 'like' | 'retweet';
  /** The user who reacted */
  user: any;
}

/**
 * Twitter-specific quote tweet received payload
 */
export interface TwitterQuoteReceivedPayload extends Omit<MessagePayload, 'message' | 'reaction'> {
  /** The original tweet that was quoted */
  quotedTweet: Tweet;
  /** The quote tweet */
  quoteTweet: Tweet;
  /** The user who quoted */
  user: any;
  /** The message being reacted to */
  message: TwitterMemory;
  /** Callback for handling the reaction */
  callback: HandlerCallback;
  /** The reaction details */
  reaction: {
    type: 'quote';
    entityId: UUID;
  };
}

/**
 * Twitter-specific mention received payload
 */
export interface TwitterMentionReceivedPayload extends Omit<MessagePayload, 'message'> {
  /** The tweet containing the mention */
  tweet: Tweet;
  /** The user who mentioned */
  user: any;
  /** The message being reacted to */
  message: TwitterMemory;
  /** Callback for handling the mention */
  callback: HandlerCallback;
  /** Source platform */
  source: 'twitter';
}

/**
 * Twitter-specific server joined payload
 */
export interface TwitterServerPayload extends WorldPayload {
  /** The Twitter profile */
  profile: {
    id: string;
    username: string;
    screenName: string;
  };
}

/**
 * Twitter-specific user joined payload
 */
export interface TwitterUserJoinedPayload extends EntityPayload {
  /** The Twitter user who joined */
  twitterUser: {
    id: string;
    username: string;
    name: string;
  };
}

/**
 * Twitter-specific user followed payload
 */
export interface TwitterUserFollowedPayload extends EntityPayload {
  /** The user who followed */
  follower: any;
}

/**
 * Twitter-specific user unfollowed payload
 */
export interface TwitterUserUnfollowedPayload extends EntityPayload {
  /** The user who unfollowed */
  unfollower: any;
}

/**
 * Twitter-specific thread created payload
 */
export interface TwitterThreadCreatedPayload extends EventPayload {
  /** The tweets in the thread */
  tweets: Tweet[];
  /** The user who created the thread */
  user: any;
}

/**
 * Twitter-specific thread updated payload
 */
export interface TwitterThreadUpdatedPayload extends EventPayload {
  /** The tweets in the thread */
  tweets: Tweet[];
  /** The user who updated the thread */
  user: any;
  /** The new tweet that was added */
  newTweet: Tweet;
}

/**
 * Maps Twitter event types to their payload interfaces
 */
export interface TwitterEventPayloadMap {
  [TwitterEventTypes.MESSAGE_RECEIVED]: TwitterMessageReceivedPayload;
  [TwitterEventTypes.MESSAGE_SENT]: TwitterMessageSentPayload;
  [TwitterEventTypes.POST_GENERATED]: TwitterPostGeneratedPayload;
  [TwitterEventTypes.POST_SENT]: TwitterPostSentPayload;
  [TwitterEventTypes.REACTION_RECEIVED]: TwitterReactionReceivedPayload;
  [TwitterEventTypes.LIKE_RECEIVED]: TwitterLikeReceivedPayload;
  [TwitterEventTypes.RETWEET_RECEIVED]: TwitterRetweetReceivedPayload;
  [TwitterEventTypes.QUOTE_RECEIVED]: TwitterQuoteReceivedPayload;
  [TwitterEventTypes.WORLD_JOINED]: TwitterServerPayload;
  [TwitterEventTypes.ENTITY_JOINED]: TwitterUserJoinedPayload;
  [TwitterEventTypes.ENTITY_LEFT]: EntityPayload;
  [TwitterEventTypes.USER_FOLLOWED]: TwitterUserFollowedPayload;
  [TwitterEventTypes.USER_UNFOLLOWED]: TwitterUserUnfollowedPayload;
  [TwitterEventTypes.THREAD_CREATED]: TwitterThreadCreatedPayload;
  [TwitterEventTypes.THREAD_UPDATED]: TwitterThreadUpdatedPayload;
  [TwitterEventTypes.MENTION_RECEIVED]: TwitterMentionReceivedPayload;
}

/**
 * Twitter-specific interaction memory
 */
export interface TwitterInteractionMemory extends TwitterMemory {
  content: {
    type: string;
    source: 'twitter';
    targetId?: string;
  };
}

/**
 * Twitter-specific interaction payload
 */
export interface TwitterInteractionPayload {
  id: string;
  type: 'like' | 'retweet' | 'quote';
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
  source: 'twitter';
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
  source: 'twitter';
}

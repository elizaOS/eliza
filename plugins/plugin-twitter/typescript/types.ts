import type {
  EntityPayload,
  EventPayload,
  HandlerCallback,
  Memory,
  MessagePayload,
  UUID,
  WorldPayload,
  Service,
} from "@elizaos/core";

/**
 * Defines a type for media data, which includes a Buffer representing the actual data
 * and a mediaType string indicating the type of media.
 */
export type MediaData = {
  data: Buffer;
  mediaType: string;
};

/**
 * Interface representing the response from an action.
 */
export interface ActionResponse {
  like: boolean;
  retweet: boolean;
  quote?: boolean;
  reply?: boolean;
}

/**
 * Twitter client instance type
 */
export interface TwitterClientInstance {
  // Placeholder for actual client implementation
}

/**
 * Extended interface for TwitterService with proper typing
 */
export interface ITwitterService extends Service {
  twitterClient?: TwitterClientInstance;
}

export const ServiceType = {
  TWITTER: "twitter",
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
  videos: unknown[];
  thread: unknown[];
  permanentUrl: string;
};

export interface QueryTweetsResponse {
  tweets: Tweet[];
  cursor?: string;
}

/**
 * Twitter-specific event types
 */
export enum TwitterEventTypes {
  MESSAGE_RECEIVED = "TWITTER_MESSAGE_RECEIVED",
  MESSAGE_SENT = "TWITTER_MESSAGE_SENT",
  REACTION_RECEIVED = "TWITTER_REACTION_RECEIVED",
  LIKE_RECEIVED = "TWITTER_LIKE_RECEIVED",
  RETWEET_RECEIVED = "TWITTER_RETWEET_RECEIVED",
  QUOTE_RECEIVED = "TWITTER_QUOTE_RECEIVED",
  WORLD_JOINED = "TWITTER_WORLD_JOINED",
  ENTITY_JOINED = "TWITTER_USER_JOINED",
  ENTITY_LEFT = "TWITTER_USER_LEFT",
  USER_FOLLOWED = "TWITTER_USER_FOLLOWED",
  USER_UNFOLLOWED = "TWITTER_USER_UNFOLLOWED",
  THREAD_CREATED = "TWITTER_THREAD_CREATED",
  THREAD_UPDATED = "TWITTER_THREAD_UPDATED",
  MENTION_RECEIVED = "TWITTER_MENTION_RECEIVED",
}

/**
 * Twitter-specific memory interface
 */
export interface TwitterMemory extends Memory {
  content: {
    source: "twitter";
    text?: string;
    type?: string;
    targetId?: string;
    [key: string]: unknown;
  };
  roomId: UUID;
}

/**
 * Twitter-specific message received payload
 */
export interface TwitterMessageReceivedPayload
  extends Omit<MessagePayload, "message"> {
  message: TwitterMemory;
  tweet: Tweet;
  user: unknown;
}

/**
 * Twitter-specific message sent payload (for replies)
 */
export interface TwitterMessageSentPayload extends MessagePayload {
  inReplyToTweetId: string;
  tweetResult: unknown;
}

/**
 * Twitter-specific reaction received payload
 */
export interface TwitterReactionReceivedPayload extends MessagePayload {
  tweet: Tweet;
  reactionType: "like" | "retweet";
  user: unknown;
}

/**
 * Twitter-specific quote tweet received payload
 */
export interface TwitterQuoteReceivedPayload
  extends Omit<MessagePayload, "message" | "reaction"> {
  quotedTweet: Tweet;
  quoteTweet: Tweet;
  user: unknown;
  message: TwitterMemory;
  callback: HandlerCallback;
  reaction: {
    type: "quote";
    entityId: UUID;
  };
}

/**
 * Twitter-specific mention received payload
 */
export interface TwitterMentionReceivedPayload
  extends Omit<MessagePayload, "message"> {
  tweet: Tweet;
  user: unknown;
  message: TwitterMemory;
  callback: HandlerCallback;
  source: "twitter";
}

/**
 * Twitter-specific server joined payload
 */
export interface TwitterServerPayload extends WorldPayload {
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
  follower: unknown;
}

/**
 * Twitter-specific user unfollowed payload
 */
export interface TwitterUserUnfollowedPayload extends EntityPayload {
  unfollower: unknown;
}

/**
 * Twitter-specific thread created payload
 */
export interface TwitterThreadCreatedPayload extends EventPayload {
  tweets: Tweet[];
  user: unknown;
}

/**
 * Twitter-specific thread updated payload
 */
export interface TwitterThreadUpdatedPayload extends EventPayload {
  tweets: Tweet[];
  user: unknown;
  newTweet: Tweet;
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

/**
 * Maps Twitter event types to their payload interfaces
 */
export interface TwitterEventPayloadMap {
  [TwitterEventTypes.MESSAGE_RECEIVED]: TwitterMessageReceivedPayload;
  [TwitterEventTypes.MESSAGE_SENT]: TwitterMessageSentPayload;
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

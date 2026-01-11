/**
 * Type definitions for plugin-xai
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { Tweet } from "./client";

export type XServiceStatus = "idle" | "active" | "error";

export interface XClientConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * Twitter-specific event types
 */
export enum TwitterEventTypes {
  MENTION_RECEIVED = "TWITTER_MENTION_RECEIVED",
  THREAD_CREATED = "TWITTER_THREAD_CREATED",
  THREAD_UPDATED = "TWITTER_THREAD_UPDATED",
  LIKE_RECEIVED = "TWITTER_LIKE_RECEIVED",
  RETWEET_RECEIVED = "TWITTER_RETWEET_RECEIVED",
  QUOTE_RECEIVED = "TWITTER_QUOTE_RECEIVED",
}

/**
 * Twitter interaction payload
 */
export interface TwitterInteractionPayload {
  id: string;
  type: "like" | "retweet" | "quote";
  userId: string;
  username: string;
  name: string;
  targetTweetId?: string;
  targetTweet: Tweet;
  quoteTweet?: Tweet;
  retweetId?: string;
}

/**
 * Twitter interaction memory
 */
export interface TwitterInteractionMemory extends Memory {
  content: {
    type: string;
    source: "twitter";
  };
}

/**
 * Twitter memory
 */
export interface TwitterMemory extends Memory {
  content: {
    text: string;
    source: "twitter";
  };
}

/**
 * Twitter like received payload
 */
export interface TwitterLikeReceivedPayload {
  runtime: IAgentRuntime;
  tweet: Tweet;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "twitter";
}

/**
 * Twitter retweet received payload
 */
export interface TwitterRetweetReceivedPayload {
  runtime: IAgentRuntime;
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
 * Twitter quote received payload
 */
export interface TwitterQuoteReceivedPayload {
  runtime: IAgentRuntime;
  quotedTweet: Tweet;
  quoteTweet: Tweet;
  user: {
    id: string;
    username: string;
    name: string;
  };
  message: TwitterMemory;
  callback: () => Promise<Memory[]>;
  reaction: {
    type: "quote";
    entityId: string;
  };
  source: "twitter";
}

/**
 * Action response from Twitter actions
 */
export interface ActionResponse {
  text: string;
  actions: string[];
  like?: boolean;
  retweet?: boolean;
  quote?: boolean;
  reply?: boolean;
}

/**
 * Media data for tweets
 */
export interface MediaData {
  data: Buffer | Uint8Array;
  type: string;
  filename?: string;
}

import type { ClientBase } from "./base";
import type { TwitterDiscoveryClient } from "./discovery";
import type { TwitterInteractionClient } from "./interactions";
import type { TwitterPostClient } from "./post";
import type { TwitterTimelineClient } from "./timeline";

/**
 * X Client interface
 */
export interface IXClient {
  client: ClientBase;
  post?: TwitterPostClient;
  interaction?: TwitterInteractionClient;
  timeline?: TwitterTimelineClient;
  discovery?: TwitterDiscoveryClient;
}

// Re-export Tweet type for convenience
export type { Tweet } from "./client";

// Re-export TwitterConfig from environment
export type { TwitterConfig } from "./environment";

// ITwitterClient is not defined - using IXClient as alias
export type ITwitterClient = IXClient;

/**
 * Twitter API response structure - can have nested data structures
 * This covers various Twitter API v2 response shapes
 */
export interface TweetResponse {
  id?: string;
  rest_id?: string;
  data?: TweetResponseData;
}

export interface TweetResponseData {
  id?: string;
  data?: {
    id?: string;
  };
  create_tweet?: {
    tweet_results?: {
      result?: {
        rest_id?: string;
      };
    };
  };
}

/**
 * A type-safe accessor for extracting tweet IDs from various Twitter API response shapes.
 * The Twitter API can return data in multiple nested formats.
 */
export interface TwitterApiResultShape {
  id?: string;
  rest_id?: string;
  data?: {
    id?: string;
    data?: {
      id?: string;
    };
    create_tweet?: {
      tweet_results?: {
        result?: {
          rest_id?: string;
        };
      };
    };
  };
}

/**
 * Shape for objects that may have a json() method (Response-like)
 */
export interface ResponseLike {
  json?: () => Promise<unknown>;
  clone?: () => ResponseLike;
  bodyUsed?: boolean;
}

/**
 * Utility type guard to check if value conforms to TwitterApiResultShape
 */
export function isTwitterApiResult(value: unknown): value is TwitterApiResultShape {
  return value !== null && typeof value === "object";
}

/**
 * Utility type guard to check if value is response-like
 */
export function isResponseLike(value: unknown): value is ResponseLike {
  return value !== null && typeof value === "object" && "json" in value;
}

/**
 * Extract ID from various Twitter API response shapes
 */
export function extractIdFromResult(result: unknown): string | undefined {
  if (!isTwitterApiResult(result)) return undefined;

  // Direct ID
  if (result.id) return result.id;

  // rest_id at root
  if (result.rest_id) return result.rest_id;

  // Nested in data
  if (result.data?.id) return result.data.id;

  // Double nested
  if (result.data?.data?.id) return result.data.data.id;

  // Tweet creation response shape
  if (result.data?.create_tweet?.tweet_results?.result?.rest_id) {
    return result.data.create_tweet.tweet_results.result.rest_id;
  }

  return undefined;
}

/**
 * Extract rest_id from Twitter API response shapes
 */
export function extractRestId(result: unknown): string | undefined {
  if (!isTwitterApiResult(result)) return undefined;

  if (result.rest_id) return result.rest_id;

  if (result.data?.create_tweet?.tweet_results?.result?.rest_id) {
    return result.data.create_tweet.tweet_results.result.rest_id;
  }

  return undefined;
}

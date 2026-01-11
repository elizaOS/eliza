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
 * X-specific event types
 */
export enum XEventTypes {
  MENTION_RECEIVED = "X_MENTION_RECEIVED",
  THREAD_CREATED = "X_THREAD_CREATED",
  THREAD_UPDATED = "X_THREAD_UPDATED",
  LIKE_RECEIVED = "X_LIKE_RECEIVED",
  REPOST_RECEIVED = "X_REPOST_RECEIVED",
  QUOTE_RECEIVED = "X_QUOTE_RECEIVED",
}

// Keep backward compatibility alias
export const TwitterEventTypes = XEventTypes;

/**
 * X interaction payload
 */
export interface XInteractionPayload {
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

// Keep backward compatibility alias
export type TwitterInteractionPayload = XInteractionPayload;

/**
 * X interaction memory
 */
export interface XInteractionMemory extends Memory {
  content: {
    type: string;
    source: "x";
  };
}

// Keep backward compatibility alias
export type TwitterInteractionMemory = XInteractionMemory;

/**
 * X memory
 */
export interface XMemory extends Memory {
  content: {
    text: string;
    source: "x";
  };
}

// Keep backward compatibility alias
export type TwitterMemory = XMemory;

/**
 * X like received payload
 */
export interface XLikeReceivedPayload {
  runtime: IAgentRuntime;
  tweet: Tweet;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "x";
}

// Keep backward compatibility alias
export type TwitterLikeReceivedPayload = XLikeReceivedPayload;

/**
 * X repost received payload
 */
export interface XRepostReceivedPayload {
  runtime: IAgentRuntime;
  tweet: Tweet;
  retweetId: string;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "x";
}

// Keep backward compatibility alias
export type TwitterRetweetReceivedPayload = XRepostReceivedPayload;

/**
 * X quote received payload
 */
export interface XQuoteReceivedPayload {
  runtime: IAgentRuntime;
  quotedTweet: Tweet;
  quoteTweet: Tweet;
  user: {
    id: string;
    username: string;
    name: string;
  };
  message: XMemory;
  callback: () => Promise<Memory[]>;
  reaction: {
    type: "quote";
    entityId: string;
  };
  source: "x";
}

// Keep backward compatibility alias
export type TwitterQuoteReceivedPayload = XQuoteReceivedPayload;

/**
 * Action response from X actions
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
import type { XDiscoveryClient } from "./discovery";
import type { XInteractionClient } from "./interactions";
import type { XPostClient } from "./post";
import type { XTimelineClient } from "./timeline";

/**
 * X Client interface
 */
export interface IXClient {
  client: ClientBase;
  post?: XPostClient;
  interaction?: XInteractionClient;
  timeline?: XTimelineClient;
  discovery?: XDiscoveryClient;
}

// Re-export Tweet type for convenience
export type { Tweet } from "./client";

// Re-export XConfig from environment
export type { XConfig } from "./environment";

// Keep backward compatibility aliases
export type TwitterConfig = XConfig;
export type ITwitterClient = IXClient;

/**
 * X API response structure - can have nested data structures
 * This covers various X API v2 response shapes
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
 * A type-safe accessor for extracting post IDs from various X API response shapes.
 * The X API can return data in multiple nested formats.
 */
export interface XApiResultShape {
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

// Keep backward compatibility alias
export type TwitterApiResultShape = XApiResultShape;

/**
 * Utility type guard to check if value conforms to XApiResultShape
 */
export function isXApiResult(value: unknown): value is XApiResultShape {
  return value !== null && typeof value === "object";
}

/**
 * Utility type guard to check if value is response-like
 */
export function isResponseLike(value: unknown): value is ResponseLike {
  return value !== null && typeof value === "object" && "json" in value;
}

// Keep backward compatibility alias
export const isTwitterApiResult = isXApiResult;

/**
 * Extract ID from various X API response shapes
 */
export function extractIdFromResult(result: unknown): string | undefined {
  if (!isXApiResult(result)) return undefined;

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
 * Extract rest_id from X API response shapes
 */
export function extractRestId(result: unknown): string | undefined {
  if (!isXApiResult(result)) return undefined;

  if (result.rest_id) return result.rest_id;

  if (result.data?.create_tweet?.tweet_results?.result?.rest_id) {
    return result.data.create_tweet.tweet_results.result.rest_id;
  }

  return undefined;
}

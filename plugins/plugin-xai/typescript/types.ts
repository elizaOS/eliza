/**
 * Type definitions for plugin-xai
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { Post as ClientPost } from "./client";

// Re-export Post type
export type { Post } from "./client";
type Post = ClientPost;

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

/**
 * X interaction payload
 */
export interface XInteractionPayload {
  id: string;
  type: "like" | "repost" | "quote";
  userId: string;
  username: string;
  name: string;
  targetPostId?: string;
  targetPost: Post;
  quotePost?: Post;
  repostId?: string;
}

/**
 * X interaction memory
 */
export interface XInteractionMemory extends Memory {
  content: {
    type: string;
    source: "x";
  };
}

/**
 * X memory
 */
export interface XMemory extends Memory {
  content: {
    text: string;
    source: "x";
  };
}

/**
 * X like received payload
 */
export interface XLikeReceivedPayload {
  runtime: IAgentRuntime;
  post: Post;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "x";
}

/**
 * X repost received payload
 */
export interface XRepostReceivedPayload {
  runtime: IAgentRuntime;
  post: Post;
  repostId: string;
  user: {
    id: string;
    username: string;
    name: string;
  };
  source: "x";
}

/**
 * X quote received payload
 */
export interface XQuoteReceivedPayload {
  runtime: IAgentRuntime;
  quotedPost: Post;
  quotePost: Post;
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

/**
 * Action response from X actions
 */
export interface ActionResponse {
  text: string;
  actions: string[];
  like?: boolean;
  repost?: boolean;
  quote?: boolean;
  reply?: boolean;
}

/**
 * Media data for posts
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


/**
 * X API response structure - can have nested data structures
 * This covers various X API v2 response shapes
 */
export interface PostResponse {
  id?: string;
  rest_id?: string;
  data?: PostResponseData;
}

export interface PostResponseData {
  id?: string;
  data?: {
    id?: string;
  };
  create_post?: {
    post_results?: {
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
    create_post?: {
      post_results?: {
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

  // Post creation response shape
  if (result.data?.create_post?.post_results?.result?.rest_id) {
    return result.data.create_post.post_results.result.rest_id;
  }

  return undefined;
}

/**
 * Extract rest_id from X API response shapes
 */
export function extractRestId(result: unknown): string | undefined {
  if (!isXApiResult(result)) return undefined;

  if (result.rest_id) return result.rest_id;

  if (result.data?.create_post?.post_results?.result?.rest_id) {
    return result.data.create_post.post_results.result.rest_id;
  }

  return undefined;
}

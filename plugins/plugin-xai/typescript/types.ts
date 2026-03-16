import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { Post as ClientPost } from "./client";

export type { Post } from "./client";

type Post = ClientPost;

export type XServiceStatus = "idle" | "active" | "error";

export interface XClientConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export enum XEventTypes {
  MENTION_RECEIVED = "X_MENTION_RECEIVED",
  THREAD_CREATED = "X_THREAD_CREATED",
  THREAD_UPDATED = "X_THREAD_UPDATED",
  LIKE_RECEIVED = "X_LIKE_RECEIVED",
  REPOST_RECEIVED = "X_REPOST_RECEIVED",
  QUOTE_RECEIVED = "X_QUOTE_RECEIVED",
}

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

export interface XInteractionMemory extends Memory {
  content: {
    type: string;
    source: "x";
  };
}

export interface XMemory extends Memory {
  content: {
    text: string;
    source: "x";
  };
}

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

export interface ActionResponse {
  text: string;
  actions: string[];
  like?: boolean;
  repost?: boolean;
  quote?: boolean;
  reply?: boolean;
}

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

export interface IXClient {
  client: ClientBase;
  post?: XPostClient;
  interaction?: XInteractionClient;
  timeline?: XTimelineClient;
  discovery?: XDiscoveryClient;
}

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

export interface ResponseLike {
  json?: () => Promise<Record<string, unknown>>;
  clone?: () => ResponseLike;
  bodyUsed?: boolean;
}

export function isXApiResult(value: unknown): value is XApiResultShape {
  return value !== null && typeof value === "object";
}

export function isResponseLike(value: unknown): value is ResponseLike {
  return value !== null && typeof value === "object" && "json" in value;
}

export function extractIdFromResult(result: unknown): string | undefined {
  if (!isXApiResult(result)) return undefined;

  if (result.id) return result.id;
  if (result.rest_id) return result.rest_id;
  if (result.data?.id) return result.data.id;
  if (result.data?.data?.id) return result.data.data.id;
  if (result.data?.create_post?.post_results?.result?.rest_id) {
    return result.data.create_post.post_results.result.rest_id;
  }

  return undefined;
}

export function extractRestId(result: unknown): string | undefined {
  if (!isXApiResult(result)) return undefined;

  if (result.rest_id) return result.rest_id;

  if (result.data?.create_post?.post_results?.result?.rest_id) {
    return result.data.create_post.post_results.result.rest_id;
  }

  return undefined;
}

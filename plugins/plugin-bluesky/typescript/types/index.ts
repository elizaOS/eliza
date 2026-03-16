import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

export const BLUESKY_SERVICE_URL = "https://bsky.social";
export const BLUESKY_MAX_POST_LENGTH = 300;
export const BLUESKY_POLL_INTERVAL = 60;
export const BLUESKY_POST_INTERVAL_MIN = 1800;
export const BLUESKY_POST_INTERVAL_MAX = 3600;
export const BLUESKY_ACTION_INTERVAL = 120;
export const BLUESKY_MAX_ACTIONS = 5;
export const BLUESKY_CHAT_SERVICE_DID = "did:web:api.bsky.chat";
export const BLUESKY_SERVICE_NAME = "bluesky";

export const AT_PROTOCOL_HANDLE_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export const CACHE_TTL = {
  PROFILE: 3600000,
  TIMELINE: 300000,
  POST: 1800000,
  NOTIFICATIONS: 300000,
  CONVERSATIONS: 300000,
} as const;

export const CACHE_SIZE = {
  PROFILE: 1000,
  TIMELINE: 500,
  POST: 10000,
  NOTIFICATIONS: 1000,
  CONVERSATIONS: 100,
} as const;

export const BlueSkyConfigSchema = z.object({
  handle: z.string().regex(AT_PROTOCOL_HANDLE_REGEX, "Invalid handle format"),
  password: z.string().min(1),
  service: z.string().url().default(BLUESKY_SERVICE_URL),
  dryRun: z.boolean().default(false),
  pollInterval: z.number().positive().default(BLUESKY_POLL_INTERVAL),
  enablePost: z.boolean().default(true),
  postIntervalMin: z.number().positive().default(BLUESKY_POST_INTERVAL_MIN),
  postIntervalMax: z.number().positive().default(BLUESKY_POST_INTERVAL_MAX),
  enableActionProcessing: z.boolean().default(true),
  actionInterval: z.number().positive().default(BLUESKY_ACTION_INTERVAL),
  postImmediately: z.boolean().default(false),
  maxActionsProcessing: z.number().positive().default(BLUESKY_MAX_ACTIONS),
  enableDMs: z.boolean().default(true),
});

export type BlueSkyConfig = z.infer<typeof BlueSkyConfigSchema>;

export interface BlueSkyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  banner?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  indexedAt?: string;
  createdAt?: string;
}

export interface PostFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type?: string;
    [key: string]: string | number | boolean | object | null | undefined;
  }>;
}

export interface PostEmbed {
  $type: string;
  [key: string]: string | number | boolean | object | null | undefined;
}

export interface PostRecord {
  $type: string;
  text: string;
  facets?: PostFacet[];
  embed?: PostEmbed;
  createdAt: string;
}

export interface BlueSkyPost {
  uri: string;
  cid: string;
  author: BlueSkyProfile;
  record: PostRecord;
  embed?: PostEmbed;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  indexedAt: string;
}

export interface TimelineRequest {
  algorithm?: string;
  limit?: number;
  cursor?: string;
}

export interface TimelineFeedItem {
  post: BlueSkyPost;
  reply?: {
    root: BlueSkyPost;
    parent: BlueSkyPost;
  };
  reason?: Record<string, string | number | boolean | object | null | undefined>;
}

export interface TimelineResponse {
  cursor?: string;
  feed: TimelineFeedItem[];
}

export interface CreatePostRequest {
  content: {
    text: string;
    facets?: PostFacet[];
    embed?: PostEmbed;
  };
  replyTo?: { uri: string; cid: string };
}

export type NotificationReason = "mention" | "reply" | "follow" | "like" | "repost" | "quote";

export interface BlueSkyNotification {
  uri: string;
  cid: string;
  author: BlueSkyProfile;
  reason: NotificationReason;
  reasonSubject?: string;
  record: Record<string, string | number | boolean | object | null | undefined>;
  isRead: boolean;
  indexedAt: string;
}

export interface BlueSkyMessage {
  id: string;
  rev: string;
  text?: string;
  embed?: PostEmbed;
  sender: { did: string };
  sentAt: string;
}

export interface BlueSkyConversation {
  id: string;
  rev: string;
  members: Array<{
    did: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  }>;
  lastMessage?: BlueSkyMessage;
  unreadCount: number;
  muted: boolean;
}

export interface SendMessageRequest {
  convoId: string;
  message: { text?: string; embed?: PostEmbed };
}

export interface BlueSkySession {
  did: string;
  handle: string;
  email?: string;
  accessJwt: string;
  refreshJwt: string;
}

export class BlueSkyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "BlueSkyError";
  }
}

export interface ATProtocolPostRecord {
  $type: string;
  text: string;
  facets?: PostFacet[];
  embed?: PostEmbed;
  createdAt: string;
  [k: string]: string | PostFacet[] | PostEmbed | number | boolean | null | undefined;
}

export interface ATProtocolProfileViewExtended {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  banner?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  indexedAt?: string;
  createdAt?: string;
  [k: string]: string | number | undefined;
}

export interface BlueSkyEventPayload {
  runtime: IAgentRuntime;
  source: "bluesky";
}

export interface BlueSkyNotificationEventPayload extends BlueSkyEventPayload {
  notification: BlueSkyNotification;
}

export interface BlueSkyCreatePostEventPayload extends BlueSkyEventPayload {
  automated: boolean;
}

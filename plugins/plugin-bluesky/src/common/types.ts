import { z } from 'zod';
import {
  AT_PROTOCOL_HANDLE_REGEX,
  AT_PROTOCOL_DID_REGEX,
  BLUESKY_MAX_POST_LENGTH,
} from './constants.js';

// Configuration schema
export const BlueSkyConfigSchema = z.object({
  handle: z.string().regex(AT_PROTOCOL_HANDLE_REGEX, 'Invalid BlueSky handle format'),
  password: z.string().min(1, 'Password is required'),
  service: z.string().url().optional(),
  dryRun: z.boolean().optional(),
  maxPostLength: z.number().positive().max(BLUESKY_MAX_POST_LENGTH).optional(),
  pollInterval: z.number().positive().optional(),
  enablePost: z.boolean().optional(),
  postIntervalMin: z.number().positive().optional(),
  postIntervalMax: z.number().positive().optional(),
  enableActionProcessing: z.boolean().optional(),
  actionInterval: z.number().positive().optional(),
  postImmediately: z.boolean().optional(),
  maxActionsProcessing: z.number().positive().optional(),
  enableDMs: z.boolean().optional(),
});

export type BlueSkyConfig = z.infer<typeof BlueSkyConfigSchema>;

// AT Protocol types
export interface ATUri {
  protocol: 'at';
  authority: string; // DID
  collection: string;
  rkey: string;
}

// Post types
export interface BlueSkyPost {
  uri: string;
  cid: string;
  author: BlueSkyProfile;
  record: {
    $type: string;
    text: string;
    facets?: Array<{
      index: {
        byteStart: number;
        byteEnd: number;
      };
      features: Array<{
        $type: string;
        [key: string]: any;
      }>;
    }>;
    embed?: {
      $type: string;
      [key: string]: any;
    };
    createdAt: string;
  };
  embed?: any;
  replyCount?: number;
  repostCount?: number;
  likeCount?: number;
  quoteCount?: number;
  indexedAt: string;
  viewer?: {
    muted?: boolean;
    mutedByList?: boolean;
    blockedBy?: boolean;
    blocking?: string;
    blockingByList?: boolean;
    following?: string;
    followedBy?: string;
    repost?: string;
    like?: string;
    threadMuted?: boolean;
    replyDisabled?: boolean;
    embeddingDisabled?: boolean;
    pinned?: boolean;
  };
  labels?: Array<{
    src: string;
    uri: string;
    cid?: string;
    val: string;
    cts: string;
  }>;
}

// Profile types
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
  associated?: any;
  indexedAt?: string;
  createdAt?: string;
  viewer?: any;
  labels?: Array<{
    src: string;
    uri: string;
    cid?: string;
    val: string;
    cts: string;
  }>;
}

// Notification types
export interface BlueSkyNotification {
  uri: string;
  cid: string;
  author: any;
  reason: string;
  reasonSubject?: string;
  record: any;
  isRead: boolean;
  indexedAt: string;
  labels?: any[];
}

// Timeline request types
export interface BlueSkyTimelineRequest {
  algorithm?: string;
  limit?: number;
  cursor?: string;
}

// Timeline response types
export interface BlueSkyTimelineResponse {
  cursor?: string;
  feed: Array<{
    post: BlueSkyPost;
    reply?: {
      root: BlueSkyPost;
      parent: BlueSkyPost;
      grandparentAuthor?: BlueSkyProfile;
    };
    reason?: any;
    feedContext?: string;
  }>;
}

// Create post types
export interface CreatePostRequest {
  content: {
    text: string;
    facets?: Array<{
      index: {
        byteStart: number;
        byteEnd: number;
      };
      features: Array<{
        $type: string;
        [key: string]: any;
      }>;
    }>;
    embed?: {
      $type: string;
      [key: string]: any;
    };
  };
  replyTo?: {
    uri: string;
    cid: string;
  };
  quote?: {
    uri: string;
    cid: string;
  };
}

// Chat/DM types
export interface BlueSkyConversation {
  id: string;
  rev: string;
  members: Array<{
    did: string;
    displayName?: string;
    handle?: string;
    avatar?: string;
  }>;
  lastMessage?: {
    id: string;
    rev: string;
    text?: string;
    embed?: any;
    sender: {
      did: string;
    };
    sentAt: string;
  };
  unreadCount: number;
  muted: boolean;
  opened?: boolean;
}

export interface BlueSkyMessage {
  id: string;
  rev: string;
  text?: string;
  embed?: any;
  sender: {
    did: string;
  };
  sentAt: string;
}

export interface SendMessageRequest {
  convoId: string;
  message: {
    text?: string;
    embed?: any;
    facets?: Array<{
      index: {
        byteStart: number;
        byteEnd: number;
      };
      features: Array<{
        $type: string;
        [key: string]: any;
      }>;
    }>;
  };
}

// Cache types
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

// Error types
export class BlueSkyError extends Error {
  constructor(
    message: string,
    public code?: string,
    public status?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'BlueSkyError';
  }
}

// Session types
export interface BlueSkySession {
  did: string;
  handle: string;
  email?: string;
  emailConfirmed?: boolean;
  emailAuthFactor?: boolean;
  accessJwt: string;
  refreshJwt: string;
  active?: boolean;
}

// Service response types
export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  cursor?: string;
}

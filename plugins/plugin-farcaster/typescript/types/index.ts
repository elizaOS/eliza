/**
 * Core types for the Farcaster plugin.
 *
 * All types use Zod for runtime validation and TypeScript for static typing.
 */

import type { Media, Memory, MessagePayload } from "@elizaos/core";
import type { Cast as NeynarCast, Embed as NeynarEmbed } from "@neynar/nodejs-sdk/build/api";
import { z } from "zod";

// ============================================================================
// Profile Types
// ============================================================================

/**
 * Farcaster user profile.
 */
export interface Profile {
  /** Farcaster ID */
  fid: number;
  /** Display name */
  name: string;
  /** Username (handle) */
  username: string;
  /** Profile picture URL */
  pfp?: string;
  /** Bio text */
  bio?: string;
  /** Profile URL */
  url?: string;
}

// ============================================================================
// Cast Types
// ============================================================================

/**
 * Embed types that can be attached to a cast.
 */
export interface CastEmbed {
  /** Type of embed: image, video, url, cast (quote), frame */
  type: "image" | "video" | "audio" | "url" | "cast" | "frame" | "unknown";
  /** URL of the embedded content */
  url: string;
  /** For embedded casts, the cast hash */
  castHash?: string;
  /** Metadata about the embed from Neynar */
  metadata?: {
    contentType?: string;
    width?: number;
    height?: number;
    duration?: number;
    title?: string;
    description?: string;
    authorFid?: number;
    authorUsername?: string;
  };
}

/**
 * A Farcaster cast (post).
 */
export interface Cast {
  /** Cast hash (unique identifier) */
  hash: string;
  /** Author's Farcaster ID */
  authorFid: number;
  /** Cast text content */
  text: string;
  /** Author's profile */
  profile: Profile;
  /** Thread ID for conversation tracking */
  threadId?: string;
  /** Parent cast if this is a reply */
  inReplyTo?: {
    hash: string;
    fid: number;
  };
  /** Cast timestamp */
  timestamp: Date;
  /** Engagement stats */
  stats?: {
    recasts: number;
    replies: number;
    likes: number;
  };
  /** Raw embeds from Neynar API */
  embeds?: NeynarEmbed[];
  /** Processed media attachments ready for elizaOS Memory */
  media?: Media[];
}

/**
 * Cast identifier.
 */
export interface CastId {
  hash: string;
  fid: number;
}

/**
 * Request parameters for fetching casts by FID.
 */
export interface FidRequest {
  fid: number;
  pageSize: number;
}

/**
 * Last cast information for caching.
 */
export interface LastCast {
  hash: string;
  timestamp: number;
}

// ============================================================================
// Configuration
// ============================================================================

/** Default maximum cast length */
export const DEFAULT_MAX_CAST_LENGTH = 320;
/** Default polling interval in seconds */
export const DEFAULT_POLL_INTERVAL = 120;
/** Default minimum cast interval in minutes */
export const DEFAULT_CAST_INTERVAL_MIN = 90;
/** Default maximum cast interval in minutes */
export const DEFAULT_CAST_INTERVAL_MAX = 180;
/** Default cast cache TTL in milliseconds */
export const DEFAULT_CAST_CACHE_TTL = 1000 * 30 * 60;
/** Default cast cache size */
export const DEFAULT_CAST_CACHE_SIZE = 9000;

/**
 * Zod schema for Farcaster configuration validation.
 */
export const FarcasterConfigSchema = z.object({
  FARCASTER_DRY_RUN: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === "string" ? val.toLowerCase() === "true" : val)),
  FARCASTER_FID: z.number().int().min(1, "Farcaster fid is required"),
  MAX_CAST_LENGTH: z.number().int().default(DEFAULT_MAX_CAST_LENGTH),
  FARCASTER_POLL_INTERVAL: z.number().int().default(DEFAULT_POLL_INTERVAL),
  FARCASTER_MODE: z.enum(["polling", "webhook"]).default("polling"),
  ENABLE_CAST: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === "string" ? val.toLowerCase() === "true" : val)),
  CAST_INTERVAL_MIN: z.number().int(),
  CAST_INTERVAL_MAX: z.number().int(),
  ENABLE_ACTION_PROCESSING: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === "string" ? val.toLowerCase() === "true" : val)),
  ACTION_INTERVAL: z.number().int(),
  CAST_IMMEDIATELY: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === "string" ? val.toLowerCase() === "true" : val)),
  MAX_ACTIONS_PROCESSING: z.number().int(),
  FARCASTER_SIGNER_UUID: z.string().min(1, "FARCASTER_SIGNER_UUID is not set"),
  FARCASTER_NEYNAR_API_KEY: z.string().min(1, "FARCASTER_NEYNAR_API_KEY is not set"),
  FARCASTER_HUB_URL: z.string().min(1, "FARCASTER_HUB_URL is not set"),
});

export type FarcasterConfig = z.infer<typeof FarcasterConfigSchema>;

// ============================================================================
// Events
// ============================================================================

/**
 * Farcaster-specific event types.
 */
export enum FarcasterEventTypes {
  CAST_GENERATED = "FARCASTER_CAST_GENERATED",
  MENTION_RECEIVED = "FARCASTER_MENTION_RECEIVED",
  THREAD_CAST_CREATED = "FARCASTER_THREAD_CAST_CREATED",
}

/**
 * Farcaster message types.
 */
export enum FarcasterMessageType {
  CAST = "CAST",
  REPLY = "REPLY",
}

/**
 * Generic cast event payload.
 */
export interface FarcasterGenericCastPayload extends Omit<MessagePayload, "message"> {
  memory: Memory;
  cast: NeynarCast;
}

// ============================================================================
// Webhook Types
// ============================================================================

/**
 * Neynar webhook data structure for cast events.
 */
export interface NeynarWebhookData {
  type: string;
  data?: {
    hash: string;
    text?: string;
    author: {
      fid: number;
      username?: string;
    };
    mentioned_profiles?: Array<{ fid: number }>;
    parent_hash?: string;
    parent_author?: { fid: number };
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Service name for registration */
export const FARCASTER_SERVICE_NAME = "farcaster";
/** Source identifier for messages */
export const FARCASTER_SOURCE = "farcaster";

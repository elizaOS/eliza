import type { Media, Memory, MessagePayload } from "@elizaos/core";
import type { Cast as NeynarCast, Embed as NeynarEmbed } from "@neynar/nodejs-sdk/build/api";
import { z } from "zod";

export interface Profile {
  fid: number;
  name: string;
  username: string;
  pfp?: string;
  bio?: string;
  url?: string;
}

export interface CastEmbed {
  type: "image" | "video" | "audio" | "url" | "cast" | "frame" | "unknown";
  url: string;
  castHash?: string;
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

export interface Cast {
  hash: string;
  authorFid: number;
  text: string;
  profile: Profile;
  threadId?: string;
  inReplyTo?: {
    hash: string;
    fid: number;
  };
  timestamp: Date;
  stats?: {
    recasts: number;
    replies: number;
    likes: number;
  };
  embeds?: NeynarEmbed[];
  media?: Media[];
}

export interface CastId {
  hash: string;
  fid: number;
}

export interface FidRequest {
  fid: number;
  pageSize: number;
}

export interface LastCast {
  hash: string;
  timestamp: number;
}

export const DEFAULT_MAX_CAST_LENGTH = 320;
export const DEFAULT_POLL_INTERVAL = 120;
export const DEFAULT_CAST_INTERVAL_MIN = 90;
export const DEFAULT_CAST_INTERVAL_MAX = 180;
export const DEFAULT_CAST_CACHE_TTL = 1000 * 30 * 60;
export const DEFAULT_CAST_CACHE_SIZE = 9000;

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

export enum FarcasterEventTypes {
  CAST_GENERATED = "FARCASTER_CAST_GENERATED",
  MENTION_RECEIVED = "FARCASTER_MENTION_RECEIVED",
  THREAD_CAST_CREATED = "FARCASTER_THREAD_CAST_CREATED",
}

export enum FarcasterMessageType {
  CAST = "CAST",
  REPLY = "REPLY",
}

export interface FarcasterGenericCastPayload extends Omit<MessagePayload, "message"> {
  memory: Memory;
  cast: NeynarCast;
}

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

export const FARCASTER_SERVICE_NAME = "farcaster";
export const FARCASTER_SOURCE = "farcaster";

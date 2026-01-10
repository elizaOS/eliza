import { type Media, Memory, MessagePayload } from '@elizaos/core';
import { DEFAULT_MAX_CAST_LENGTH, DEFAULT_POLL_INTERVAL } from './constants';

import { Cast as NeynarCast, Embed as NeynarEmbed } from '@neynar/nodejs-sdk/build/api';
import { z } from 'zod';

export type Profile = {
  fid: number;
  name: string;
  username: string;
  pfp?: string;
  bio?: string;
  url?: string;
};

/**
 * Embed types that can be attached to a cast
 */
export type CastEmbed = {
  /** Type of embed: image, video, url, cast (quote), frame */
  type: 'image' | 'video' | 'audio' | 'url' | 'cast' | 'frame' | 'unknown';
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
};

export type Cast = {
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
  /** Raw embeds from Neynar API */
  embeds?: NeynarEmbed[];
  /** Processed media attachments ready for elizaos Memory */
  media?: Media[];
};

export type CastId = {
  hash: string;
  fid: number;
};

export type FidRequest = {
  fid: number;
  pageSize: number;
};

export interface LastCast {
  hash: string;
  timestamp: number;
}

/**
 * This schema defines all required/optional environment settings for Farcaster client
 */
export const FarcasterConfigSchema = z.object({
  FARCASTER_DRY_RUN: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : val)),
  FARCASTER_FID: z.number().int().min(1, 'Farcaster fid is required'),
  MAX_CAST_LENGTH: z.number().int().default(DEFAULT_MAX_CAST_LENGTH),
  FARCASTER_POLL_INTERVAL: z.number().int().default(DEFAULT_POLL_INTERVAL),
  
  // Webhook configuration
  FARCASTER_MODE: z.enum(['polling', 'webhook']).default('polling'),
  ENABLE_CAST: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : val)),
  CAST_INTERVAL_MIN: z.number().int(),
  CAST_INTERVAL_MAX: z.number().int(),
  ENABLE_ACTION_PROCESSING: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : val)),
  ACTION_INTERVAL: z.number().int(),
  CAST_IMMEDIATELY: z
    .union([z.boolean(), z.string()])
    .transform((val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : val)),
  MAX_ACTIONS_PROCESSING: z.number().int(),
  FARCASTER_SIGNER_UUID: z.string().min(1, 'FARCASTER_SIGNER_UUID is not set'),
  FARCASTER_NEYNAR_API_KEY: z.string().min(1, 'FARCASTER_NEYNAR_API_KEY is not set'),
  FARCASTER_HUB_URL: z.string().min(1, 'FARCASTER_HUB_URL is not set'),
});

export type FarcasterConfig = z.infer<typeof FarcasterConfigSchema>;

export enum FarcasterEventTypes {
  CAST_GENERATED = 'FARCASTER_CAST_GENERATED',
  MENTION_RECEIVED = 'FARCASTER_MENTION_RECEIVED',
  THREAD_CAST_CREATED = 'FARCASTER_THREAD_CAST_CREATED',
}

export enum FarcasterMessageType {
  CAST = 'CAST',
  REPLY = 'REPLY',
}

export interface FarcasterGenericCastPayload extends Omit<MessagePayload, 'message'> {
  memory: Memory;
  cast: NeynarCast;
}

/**
 * Neynar webhook data structure for cast events
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

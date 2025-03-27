import { DEFAULT_MAX_CAST_LENGTH, DEFAULT_POLL_INTERVAL } from './constants';

import { z } from 'zod';

export type Profile = {
  fid: number;
  name: string;
  username: string;
  pfp?: string;
  bio?: string;
  url?: string;
  // location?: string;
  // twitter?: string;
  // github?: string;
};

export type NeynarCastResponse = {
  hash: string;
  authorFid: number;
  text: string;
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
  FARCASTER_DRY_RUN: z.boolean(),
  FARCASTER_FID: z.number().int().min(1, 'Farcaster fid is required'),
  MAX_CAST_LENGTH: z.number().int().default(DEFAULT_MAX_CAST_LENGTH),
  FARCASTER_POLL_INTERVAL: z.number().int().default(DEFAULT_POLL_INTERVAL),
  ENABLE_POST: z.boolean(),
  POST_INTERVAL_MIN: z.number().int(),
  POST_INTERVAL_MAX: z.number().int(),
  ENABLE_ACTION_PROCESSING: z.boolean(),
  ACTION_INTERVAL: z.number().int(),
  POST_IMMEDIATELY: z.boolean(),
  MAX_ACTIONS_PROCESSING: z.number().int(),
  FARCASTER_NEYNAR_SIGNER_UUID: z.string().min(1, 'FARCASTER_NEYNAR_SIGNER_UUID is not set'),
  FARCASTER_NEYNAR_API_KEY: z.string().min(1, 'FARCASTER_NEYNAR_API_KEY is not set'),
  FARCASTER_HUB_URL: z.string().min(1, 'FARCASTER_HUB_URL is not set'),
});

export type FarcasterConfig = z.infer<typeof FarcasterConfigSchema>;

export enum FarcasterEventTypes {
  POST_GENERATED = 'FARCASTER_POST_GENERATED',
  // CAST_GENERATED = 'FARCASTER_CAST_GENERATED',
  // CAST_SENT = 'FARCASTER_CAST_SENT',
  // CAST_REACTION_RECEIVED = 'FARCASTER_CAST_REACTION_RECEIVED',
  // CAST_REACTION_SENT = 'FARCASTER_CAST_REACTION_SENT',
}

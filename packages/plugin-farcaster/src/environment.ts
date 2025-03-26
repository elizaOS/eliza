import { parseBooleanFromText, type IAgentRuntime } from '@elizaos/core';
import { z, ZodError } from 'zod';

export const DEFAULT_MAX_CAST_LENGTH = 320;
const DEFAULT_POLL_INTERVAL = 120; // 2 minutes
const DEFAULT_POST_INTERVAL_MIN = 90; // 1.5 hours
const DEFAULT_POST_INTERVAL_MAX = 180; // 3 hours
/**
 * This schema defines all required/optional environment settings for Farcaster client
 */
export const farcasterEnvSchema = z.object({
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
});

export type FarcasterConfig = z.infer<typeof farcasterEnvSchema>;

function safeParseInt(value: string | undefined | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

/**
 * Validates or constructs a FarcasterConfig object using zod,
 * taking values from the IAgentRuntime or process.env as needed.
 */
export function validateFarcasterConfig(runtime: IAgentRuntime): FarcasterConfig {
  try {
    const farcasterConfig = {
      FARCASTER_DRY_RUN: parseBooleanFromText(
        runtime.getSetting('FARCASTER_DRY_RUN') || process.env.FARCASTER_DRY_RUN || 'false'
      ),

      FARCASTER_FID: safeParseInt(
        runtime.getSetting('FARCASTER_FID') || process.env.FARCASTER_FID,
        0
      ),

      MAX_CAST_LENGTH: safeParseInt(
        runtime.getSetting('MAX_CAST_LENGTH') || process.env.MAX_CAST_LENGTH,
        DEFAULT_MAX_CAST_LENGTH
      ),

      FARCASTER_POLL_INTERVAL: safeParseInt(
        runtime.getSetting('FARCASTER_POLL_INTERVAL') || process.env.FARCASTER_POLL_INTERVAL,
        DEFAULT_POLL_INTERVAL
      ),

      ENABLE_POST: parseBooleanFromText(
        runtime.getSetting('ENABLE_POST') || process.env.ENABLE_POST || 'true'
      ),

      POST_INTERVAL_MIN: safeParseInt(
        runtime.getSetting('POST_INTERVAL_MIN') || process.env.POST_INTERVAL_MIN,
        DEFAULT_POST_INTERVAL_MIN
      ),

      POST_INTERVAL_MAX: safeParseInt(
        runtime.getSetting('POST_INTERVAL_MAX') || process.env.POST_INTERVAL_MAX,
        DEFAULT_POST_INTERVAL_MAX
      ),

      ENABLE_ACTION_PROCESSING:
        parseBooleanFromText(
          runtime.getSetting('ENABLE_ACTION_PROCESSING') ||
            process.env.ENABLE_ACTION_PROCESSING ||
            'false'
        ) ?? false,

      ACTION_INTERVAL: safeParseInt(
        runtime.getSetting('ACTION_INTERVAL') || process.env.ACTION_INTERVAL,
        5 // 5 minutes
      ),

      POST_IMMEDIATELY:
        parseBooleanFromText(
          runtime.getSetting('POST_IMMEDIATELY') || process.env.POST_IMMEDIATELY || 'false'
        ) ?? false,

      MAX_ACTIONS_PROCESSING: safeParseInt(
        runtime.getSetting('MAX_ACTIONS_PROCESSING') || process.env.MAX_ACTIONS_PROCESSING,
        1
      ),
    };

    return farcasterEnvSchema.parse(farcasterConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.errors
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Farcaster configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

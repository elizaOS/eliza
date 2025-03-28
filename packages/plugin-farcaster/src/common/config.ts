import { logger, parseBooleanFromText, type IAgentRuntime } from '@elizaos/core';
import { ZodError } from 'zod';
import {
  DEFAULT_MAX_CAST_LENGTH,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_POST_INTERVAL_MAX,
  DEFAULT_POST_INTERVAL_MIN,
} from './constants';
import { FarcasterConfig, FarcasterConfigSchema } from './types';

function safeParseInt(value: string | undefined | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

export function hasFarcasterEnabled(runtime: IAgentRuntime): boolean {
  const fid = runtime.getSetting('FARCASTER_FID');
  const neynarSignerUuid = runtime.getSetting('FARCASTER_NEYNAR_SIGNER_UUID');
  const neynarApiKey = runtime.getSetting('FARCASTER_NEYNAR_API_KEY');

  return fid && neynarSignerUuid && neynarApiKey;
}

/**
 * Validates or constructs a FarcasterConfig object using zod,
 * taking values from the IAgentRuntime or process.env as needed.
 */
export function validateFarcasterConfig(runtime: IAgentRuntime): FarcasterConfig {
  const fid = Number.parseInt(runtime.getSetting('FARCASTER_FID'));

  try {
    const farcasterConfig = {
      FARCASTER_DRY_RUN: parseBooleanFromText(runtime.getSetting('FARCASTER_DRY_RUN') || 'false'),

      FARCASTER_FID: Number.isNaN(fid) ? undefined : fid,

      MAX_CAST_LENGTH: safeParseInt(runtime.getSetting('MAX_CAST_LENGTH'), DEFAULT_MAX_CAST_LENGTH),

      FARCASTER_POLL_INTERVAL: safeParseInt(
        runtime.getSetting('FARCASTER_POLL_INTERVAL'),
        DEFAULT_POLL_INTERVAL
      ),

      ENABLE_POST: parseBooleanFromText(runtime.getSetting('ENABLE_POST') || 'true'),

      POST_INTERVAL_MIN: safeParseInt(
        runtime.getSetting('POST_INTERVAL_MIN'),
        DEFAULT_POST_INTERVAL_MIN
      ),

      POST_INTERVAL_MAX: safeParseInt(
        runtime.getSetting('POST_INTERVAL_MAX'),
        DEFAULT_POST_INTERVAL_MAX
      ),

      ENABLE_ACTION_PROCESSING: parseBooleanFromText(
        runtime.getSetting('ENABLE_ACTION_PROCESSING') || 'false'
      ),

      ACTION_INTERVAL: safeParseInt(runtime.getSetting('ACTION_INTERVAL'), 5), // 5 minutes

      POST_IMMEDIATELY: parseBooleanFromText(runtime.getSetting('POST_IMMEDIATELY') || 'false'),

      MAX_ACTIONS_PROCESSING: safeParseInt(runtime.getSetting('MAX_ACTIONS_PROCESSING'), 1),

      FARCASTER_NEYNAR_SIGNER_UUID: runtime.getSetting('FARCASTER_NEYNAR_SIGNER_UUID'),

      FARCASTER_NEYNAR_API_KEY: runtime.getSetting('FARCASTER_NEYNAR_API_KEY'),

      FARCASTER_HUB_URL: runtime.getSetting('FARCASTER_HUB_URL') ?? 'hub.pinata.cloud',
    };

    const config = FarcasterConfigSchema.parse(farcasterConfig);

    const isDryRun = config.FARCASTER_DRY_RUN;

    // Log configuration on initialization

    logger.log('Farcaster Client Configuration:');
    logger.log(`- FID: ${config.FARCASTER_FID}`);
    logger.log(`- Dry Run Mode: ${isDryRun ? 'enabled' : 'disabled'}`);
    logger.log(`- Enable Post: ${config.ENABLE_POST ? 'enabled' : 'disabled'}`);

    if (config.ENABLE_POST) {
      logger.log(
        `- Post Interval: ${config.POST_INTERVAL_MIN}-${config.POST_INTERVAL_MAX} minutes`
      );
      logger.log(`- Post Immediately: ${config.POST_IMMEDIATELY ? 'enabled' : 'disabled'}`);
    }
    logger.log(`- Action Processing: ${config.ENABLE_ACTION_PROCESSING ? 'enabled' : 'disabled'}`);
    logger.log(`- Action Interval: ${config.ACTION_INTERVAL} minutes`);

    if (isDryRun) {
      logger.log('Farcaster client initialized in dry run mode - no actual casts should be posted');
    }

    return config;
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

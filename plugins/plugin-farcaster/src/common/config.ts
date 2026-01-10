import { parseBooleanFromText, type IAgentRuntime } from '@elizaos/core';
import { ZodError } from 'zod';
import {
  DEFAULT_MAX_CAST_LENGTH,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_CAST_INTERVAL_MAX,
  DEFAULT_CAST_INTERVAL_MIN,
} from './constants';
import { FarcasterConfig, FarcasterConfigSchema } from './types';

function safeParseInt(value: string | undefined | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

/**
 * Gets the Farcaster FID from runtime settings.
 * Uses getSetting which already prioritizes: character.secrets -> character.settings -> env vars
 */
export function getFarcasterFid(runtime: IAgentRuntime): number | null {
  const fidStr = runtime.getSetting('FARCASTER_FID');
  if (!fidStr) return null;
  const fid = Number.parseInt(fidStr as string, 10);
  return Number.isNaN(fid) ? null : fid;
}

/**
 * Checks if Farcaster is properly configured for this runtime.
 * getSetting already handles priority: character.secrets -> character.settings -> env vars
 */
export function hasFarcasterEnabled(runtime: IAgentRuntime): boolean {
  const fid = runtime.getSetting('FARCASTER_FID');
  const signerUuid = runtime.getSetting('FARCASTER_SIGNER_UUID');
  const apiKey = runtime.getSetting('FARCASTER_NEYNAR_API_KEY');

  runtime.logger.debug(`[hasFarcasterEnabled] FID: ${fid ? 'Found' : 'Missing'}`);
  runtime.logger.debug(`[hasFarcasterEnabled] Signer UUID: ${signerUuid ? 'Found' : 'Missing'}`);
  runtime.logger.debug(`[hasFarcasterEnabled] API Key: ${apiKey ? 'Found' : 'Missing'}`);

  return !!(fid && signerUuid && apiKey);
}

/**
 * Constructs and validates a Farcaster configuration object using runtime settings and environment variables.
 *
 * Retrieves configuration values for the Farcaster client, applying defaults where necessary, and validates them against the {@link FarcasterConfigSchema}. Throws a detailed error if validation fails.
 *
 * @param runtime - The runtime environment providing configuration settings.
 * @returns The validated {@link FarcasterConfig} object.
 *
 * @throws {Error} If configuration validation fails, with details about each invalid field.
 */
export function validateFarcasterConfig(runtime: IAgentRuntime): FarcasterConfig {
  const fid = getFarcasterFid(runtime);

  try {
    const farcasterConfig = {
      FARCASTER_DRY_RUN:
        runtime.getSetting('FARCASTER_DRY_RUN') ||
        parseBooleanFromText(process.env.FARCASTER_DRY_RUN || 'false'),

      FARCASTER_FID: fid ?? undefined,

      MAX_CAST_LENGTH: safeParseInt(
        runtime.getSetting('MAX_CAST_LENGTH') as string,
        DEFAULT_MAX_CAST_LENGTH
      ),

      FARCASTER_POLL_INTERVAL: safeParseInt(
        runtime.getSetting('FARCASTER_POLL_INTERVAL') as string,
        DEFAULT_POLL_INTERVAL
      ),

      ENABLE_CAST:
        runtime.getSetting('ENABLE_CAST') ||
        parseBooleanFromText(process.env.ENABLE_CAST || 'true'),

      CAST_INTERVAL_MIN: safeParseInt(
        runtime.getSetting('CAST_INTERVAL_MIN') as string,
        DEFAULT_CAST_INTERVAL_MIN
      ),

      CAST_INTERVAL_MAX: safeParseInt(
        runtime.getSetting('CAST_INTERVAL_MAX') as string,
        DEFAULT_CAST_INTERVAL_MAX
      ),

      ENABLE_ACTION_PROCESSING:
        runtime.getSetting('ENABLE_ACTION_PROCESSING') ||
        parseBooleanFromText(process.env.ENABLE_ACTION_PROCESSING || 'false'),

      ACTION_INTERVAL: safeParseInt(
        runtime.getSetting('ACTION_INTERVAL') as string,
        5
      ), // 5 minutes

      CAST_IMMEDIATELY:
        runtime.getSetting('CAST_IMMEDIATELY') ||
        parseBooleanFromText(process.env.CAST_IMMEDIATELY || 'false'),

      MAX_ACTIONS_PROCESSING: safeParseInt(
        runtime.getSetting('MAX_ACTIONS_PROCESSING') as string,
        1
      ),

      FARCASTER_SIGNER_UUID: runtime.getSetting('FARCASTER_SIGNER_UUID'),

      FARCASTER_NEYNAR_API_KEY: runtime.getSetting('FARCASTER_NEYNAR_API_KEY'),

      FARCASTER_HUB_URL:
        runtime.getSetting('FARCASTER_HUB_URL') || 'hub.pinata.cloud',
      
      // Webhook configuration
      FARCASTER_MODE: runtime.getSetting('FARCASTER_MODE') || 'polling',
    };

    runtime.logger.debug(`[validateFarcasterConfig] Resolved FID: ${farcasterConfig.FARCASTER_FID}`);
    runtime.logger.debug(`[validateFarcasterConfig] Resolved Signer UUID: ${farcasterConfig.FARCASTER_SIGNER_UUID ? 'Found' : 'Missing'}`);
    runtime.logger.debug(`[validateFarcasterConfig] Resolved API Key: ${farcasterConfig.FARCASTER_NEYNAR_API_KEY ? 'Found' : 'Missing'}`);

    const config = FarcasterConfigSchema.parse(farcasterConfig);

    const isDryRun = config.FARCASTER_DRY_RUN;

    // Log configuration on initialization

    runtime.logger.info('Farcaster Client Configuration:');
    runtime.logger.info(`- FID: ${config.FARCASTER_FID}`);
    runtime.logger.info(`- Dry Run Mode: ${isDryRun ? 'enabled' : 'disabled'}`);
    runtime.logger.info(`- Enable Cast: ${config.ENABLE_CAST ? 'enabled' : 'disabled'}`);

    if (config.ENABLE_CAST) {
      runtime.logger.info(
        `- Cast Interval: ${config.CAST_INTERVAL_MIN}-${config.CAST_INTERVAL_MAX} minutes`
      );
      runtime.logger.info(`- Cast Immediately: ${config.CAST_IMMEDIATELY ? 'enabled' : 'disabled'}`);
    }
    runtime.logger.info(`- Action Processing: ${config.ENABLE_ACTION_PROCESSING ? 'enabled' : 'disabled'}`);
    runtime.logger.info(`- Action Interval: ${config.ACTION_INTERVAL} minutes`);

    if (isDryRun) {
      runtime.logger.info('Farcaster client initialized in dry run mode - no actual casts should be posted');
    }

    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Farcaster configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}

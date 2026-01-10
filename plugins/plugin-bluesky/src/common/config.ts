import { type IAgentRuntime } from '@elizaos/core';
import { BlueSkyConfigSchema, type BlueSkyConfig } from './types.js';
import {
  BLUESKY_DEFAULT_SERVICE_URL,
  BLUESKY_DEFAULT_POLL_INTERVAL,
  BLUESKY_DEFAULT_POST_INTERVAL_MIN,
  BLUESKY_DEFAULT_POST_INTERVAL_MAX,
  BLUESKY_DEFAULT_ACTION_INTERVAL,
  BLUESKY_DEFAULT_MAX_ACTIONS,
  BLUESKY_MAX_POST_LENGTH,
} from './constants.js';

/**
 * Check if BlueSky is enabled for the runtime
 */
export function hasBlueSkyEnabled(runtime: IAgentRuntime): boolean {
  const enabled = runtime.getSetting('BLUESKY_ENABLED');
  if (enabled !== undefined && enabled !== null) {
    return enabled.toLowerCase() === 'true';
  }
  
  // Fallback to checking if handle and password are set
  const handle = runtime.getSetting('BLUESKY_HANDLE');
  const password = runtime.getSetting('BLUESKY_PASSWORD');
  return Boolean(handle && password);
}

/**
 * Validate and get BlueSky configuration from runtime settings
 */
export function validateBlueSkyConfig(runtime: IAgentRuntime): BlueSkyConfig {
  const config = {
    handle: runtime.getSetting('BLUESKY_HANDLE') || '',
    password: runtime.getSetting('BLUESKY_PASSWORD') || '',
    service: runtime.getSetting('BLUESKY_SERVICE') || BLUESKY_DEFAULT_SERVICE_URL,
    dryRun: runtime.getSetting('BLUESKY_DRY_RUN') === 'true',
    maxPostLength: parseInt(
      runtime.getSetting('BLUESKY_MAX_POST_LENGTH') || `${BLUESKY_MAX_POST_LENGTH}`,
      10
    ),
    pollInterval: parseInt(
      runtime.getSetting('BLUESKY_POLL_INTERVAL') || `${BLUESKY_DEFAULT_POLL_INTERVAL}`,
      10
    ),
    enablePost: runtime.getSetting('BLUESKY_ENABLE_POSTING') !== 'false',
    postIntervalMin: parseInt(
      runtime.getSetting('BLUESKY_POST_INTERVAL_MIN') || `${BLUESKY_DEFAULT_POST_INTERVAL_MIN}`,
      10
    ),
    postIntervalMax: parseInt(
      runtime.getSetting('BLUESKY_POST_INTERVAL_MAX') || `${BLUESKY_DEFAULT_POST_INTERVAL_MAX}`,
      10
    ),
    enableActionProcessing: runtime.getSetting('BLUESKY_ENABLE_ACTION_PROCESSING') !== 'false',
    actionInterval: parseInt(
      runtime.getSetting('BLUESKY_ACTION_INTERVAL') || `${BLUESKY_DEFAULT_ACTION_INTERVAL}`,
      10
    ),
    postImmediately: runtime.getSetting('BLUESKY_POST_IMMEDIATELY') === 'true',
    maxActionsProcessing: parseInt(
      runtime.getSetting('BLUESKY_MAX_ACTIONS_PROCESSING') || `${BLUESKY_DEFAULT_MAX_ACTIONS}`,
      10
    ),
    enableDMs: runtime.getSetting('BLUESKY_ENABLE_DMS') !== 'false',
  };

  const result = BlueSkyConfigSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid BlueSky configuration: ${errors}`);
  }

  return result.data;
}

/**
 * Get the agent's BlueSky handle
 */
export function getAgentHandle(runtime: IAgentRuntime): string {
  const handle = runtime.getSetting('BLUESKY_HANDLE');
  if (!handle) {
    throw new Error('BLUESKY_HANDLE not configured');
  }
  return handle;
}

/**
 * Get the agent's BlueSky DID (if available)
 */
export function getAgentDid(runtime: IAgentRuntime): string | null {
  return runtime.getSetting('BLUESKY_DID') || null;
}

/**
 * Check if dry run mode is enabled
 */
export function isDryRun(runtime: IAgentRuntime): boolean {
  return runtime.getSetting('BLUESKY_DRY_RUN') === 'true';
}

/**
 * Get post character limit
 */
export function getPostCharacterLimit(runtime: IAgentRuntime): number {
  const limit = runtime.getSetting('BLUESKY_MAX_POST_LENGTH');
  return limit ? parseInt(limit, 10) : BLUESKY_MAX_POST_LENGTH;
}

/**
 * Check if posting is enabled
 */
export function isPostingEnabled(runtime: IAgentRuntime): boolean {
  const enabled = runtime.getSetting('BLUESKY_ENABLE_POSTING');
  if (!enabled || enabled.trim() === '') {
    return true; // Default to true
  }
  return enabled.toLowerCase() !== 'false';
}

/**
 * Check if DMs are enabled
 */
export function isDMsEnabled(runtime: IAgentRuntime): boolean {
  const enabled = runtime.getSetting('BLUESKY_ENABLE_DMS');
  if (!enabled || enabled.trim() === '') {
    return true; // Default to true
  }
  return enabled.toLowerCase() !== 'false';
}

/**
 * Get poll interval in milliseconds
 */
export function getPollInterval(runtime: IAgentRuntime): number {
  const interval = runtime.getSetting('BLUESKY_POLL_INTERVAL');
  const seconds = interval ? parseInt(interval, 10) : BLUESKY_DEFAULT_POLL_INTERVAL;
  return isNaN(seconds) ? BLUESKY_DEFAULT_POLL_INTERVAL * 1000 : seconds * 1000;
}

/**
 * Get action interval in milliseconds
 */
export function getActionInterval(runtime: IAgentRuntime): number {
  const interval = runtime.getSetting('BLUESKY_ACTION_INTERVAL');
  const seconds = interval ? parseInt(interval, 10) : BLUESKY_DEFAULT_ACTION_INTERVAL;
  return isNaN(seconds) ? BLUESKY_DEFAULT_ACTION_INTERVAL * 1000 : seconds * 1000;
}

/**
 * Get max actions to process
 */
export function getMaxActionsProcessing(runtime: IAgentRuntime): number {
  const max = runtime.getSetting('BLUESKY_MAX_ACTIONS_PROCESSING');
  const value = max ? parseInt(max, 10) : BLUESKY_DEFAULT_MAX_ACTIONS;
  return isNaN(value) ? BLUESKY_DEFAULT_MAX_ACTIONS : value;
}

/**
 * Check if should post immediately
 */
export function shouldPostImmediately(runtime: IAgentRuntime): boolean {
  const immediate = runtime.getSetting('BLUESKY_POST_IMMEDIATELY');
  return immediate === 'true';
}

/**
 * Get post interval range in milliseconds
 */
export function getPostIntervalRange(runtime: IAgentRuntime): { min: number; max: number } {
  const min = runtime.getSetting('BLUESKY_POST_INTERVAL_MIN');
  const max = runtime.getSetting('BLUESKY_POST_INTERVAL_MAX');

  const minSeconds = min ? parseInt(min, 10) : BLUESKY_DEFAULT_POST_INTERVAL_MIN;
  const maxSeconds = max ? parseInt(max, 10) : BLUESKY_DEFAULT_POST_INTERVAL_MAX;

  return {
    min: isNaN(minSeconds) ? BLUESKY_DEFAULT_POST_INTERVAL_MIN * 1000 : minSeconds * 1000,
    max: isNaN(maxSeconds) ? BLUESKY_DEFAULT_POST_INTERVAL_MAX * 1000 : maxSeconds * 1000,
  };
}

import type { ElizaOS, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import { RESPONSE_MODES, DEFAULT_RESPONSE_MODE, type ResponseMode } from './constants';

/**
 * Validates and retrieves an agent runtime from the agents map
 */
export const getRuntime = (elizaOS: ElizaOS, agentId: UUID) => {
  const runtime = elizaOS.getAgent(agentId);
  if (!runtime) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return runtime;
};

/**
 * Validates a UUID parameter and returns it as UUID type or null if invalid
 */
export const validateAgentId = (agentId: string): UUID | null => {
  return validateUuid(agentId);
};

/**
 * Validates a room ID parameter
 */
export const validateRoomId = (roomId: string): UUID | null => {
  return validateUuid(roomId);
};

/**
 * Enhanced channel ID validation with security logging
 * Validates a channel ID parameter with additional security checks
 */
export const validateChannelId = (channelId: string, clientIp?: string): UUID | null => {
  // Basic UUID validation
  const validatedUuid = validateUuid(channelId);

  if (!validatedUuid) {
    // Log invalid channel ID attempts for security monitoring
    if (clientIp) {
      logger.warn({ src: 'http', ip: clientIp, channelId }, 'Invalid channel ID attempted');
    }
    return null;
  }

  // Additional security check: ensure channel ID doesn't contain suspicious patterns
  const suspiciousPatterns = ['..', '<', '>', '"', "'", '\\', '/'];
  const hasSuspiciousPattern = suspiciousPatterns.some((pattern) => channelId.includes(pattern));

  if (hasSuspiciousPattern) {
    if (clientIp) {
      logger.warn({ src: 'http', ip: clientIp, channelId }, 'Suspicious channel ID pattern');
    }
    return null;
  }

  return validatedUuid;
};

/**
 * Validates a memory ID parameter
 */
export const validateMemoryId = (memoryId: string): UUID | null => {
  return validateUuid(memoryId);
};

/**
 * Validates a world ID parameter
 */
export const validateWorldId = (worldId: string): UUID | null => {
  return validateUuid(worldId);
};

/**
 * Validates and normalizes a response mode parameter
 * Returns the validated mode or default if invalid/missing
 *
 * @param mode - The mode parameter from the request (can be any type)
 * @returns Object with validated mode and whether it was valid
 */
export const validateResponseMode = (
  mode: unknown
): { mode: ResponseMode; isValid: boolean; error?: string } => {
  // Handle undefined/null - use default
  if (mode === undefined || mode === null) {
    return { mode: DEFAULT_RESPONSE_MODE, isValid: true };
  }

  // Must be a string
  if (typeof mode !== 'string') {
    return {
      mode: DEFAULT_RESPONSE_MODE,
      isValid: false,
      error: `Invalid mode type "${typeof mode}". Mode must be a string.`,
    };
  }

  // Must be one of the valid modes
  if (!RESPONSE_MODES.includes(mode as ResponseMode)) {
    return {
      mode: DEFAULT_RESPONSE_MODE,
      isValid: false,
      error: `Invalid mode "${mode}". Must be one of: ${RESPONSE_MODES.join(', ')}`,
    };
  }

  return { mode: mode as ResponseMode, isValid: true };
};

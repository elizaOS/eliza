import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';

/**
 * Validates and retrieves an agent runtime from the agents map
 */
export const getRuntime = (agents: Map<UUID, IAgentRuntime>, agentId: UUID) => {
  const runtime = agents.get(agentId);
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
      logger.warn(`[SECURITY] Invalid channel ID attempted from ${clientIp}: ${channelId}`);
    }
    return null;
  }

  // Additional security check: ensure channel ID doesn't contain suspicious patterns
  const suspiciousPatterns = ['..', '<', '>', '"', "'", '\\', '/'];
  const hasSuspiciousPattern = suspiciousPatterns.some((pattern) => channelId.includes(pattern));

  if (hasSuspiciousPattern) {
    if (clientIp) {
      logger.warn(`[SECURITY] Suspicious channel ID pattern from ${clientIp}: ${channelId}`);
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

import type { ElizaOS, UUID } from '@elizaos/core';
import { validateUuid, logger } from '@elizaos/core';
import {
  TRANSPORT_TYPES,
  DEFAULT_TRANSPORT,
  LEGACY_MODE_MAP,
  type TransportType,
} from './constants';

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
 * Validates and normalizes a transport type parameter
 * Supports both new transport types (http, sse, websocket) and legacy mode names (sync, stream)
 *
 * @param value - The transport/mode parameter from the request (can be any type)
 * @returns Object with validated transport and whether it was valid
 */
export const validateTransport = (
  value: unknown
): { transport: TransportType; isValid: boolean; error?: string } => {
  // Handle undefined/null - use default
  if (value === undefined || value === null) {
    return { transport: DEFAULT_TRANSPORT, isValid: true };
  }

  // Must be a string
  if (typeof value !== 'string') {
    return {
      transport: DEFAULT_TRANSPORT,
      isValid: false,
      error: `Invalid transport type "${typeof value}". Transport must be a string.`,
    };
  }

  // Check if it's a valid transport type
  if (TRANSPORT_TYPES.includes(value as TransportType)) {
    return { transport: value as TransportType, isValid: true };
  }

  // Check if it's a legacy mode name and map it
  if (value in LEGACY_MODE_MAP) {
    return { transport: LEGACY_MODE_MAP[value], isValid: true };
  }

  // Invalid value
  const allValid = [...TRANSPORT_TYPES, ...Object.keys(LEGACY_MODE_MAP)];
  return {
    transport: DEFAULT_TRANSPORT,
    isValid: false,
    error: `Invalid transport "${value}". Must be one of: ${[...new Set(allValid)].join(', ')}`,
  };
};

/**
 * @deprecated Use validateTransport instead
 * Validates and normalizes a response mode parameter (legacy API)
 */
export const validateResponseMode = (
  mode: unknown
): { mode: TransportType; isValid: boolean; error?: string } => {
  const result = validateTransport(mode);
  return { mode: result.transport, isValid: result.isValid, error: result.error };
};

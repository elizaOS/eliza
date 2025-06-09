import type { IAgentRuntime, UUID } from '@elizaos/core';
import { validateUuid } from '@elizaos/core';

/**
 * Validates and retrieves an agent runtime from the agents map
 */
export const getRuntime = (agents: Map<UUID, IAgentRuntime>, agentId: UUID) => {
  const runtime = agents.get(agentId);
  if (!runtime) {
    throw new Error('Agent not found');
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
 * Validates a channel ID parameter
 */
export const validateChannelId = (channelId: string): UUID | null => {
  return validateUuid(channelId);
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
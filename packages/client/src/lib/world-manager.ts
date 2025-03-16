import type { UUID } from '@elizaos/core';

// Key used for storing the worldId in localStorage
const WORLD_ID_KEY = 'elizaos-world-id';

/**
 * WorldManager utility for managing the current world ID
 * Each browser/device is treated as a separate "world"
 */
/**
 * WorldManager module containing functions for managing the world
 * @type {Object}
 * @property {Function} getWorldId - Get the current world ID, creating one if it doesn't exist
 * @property {Function} resetWorldId - Reset the world ID (mainly for testing purposes)
 * @property {Function} getRoomStorageKey - Get a room key that's specific to this world and agent
 */
export const WorldManager = {
  /**
   * Get the current world ID, creating one if it doesn't exist
   */
  getWorldId: (): UUID => {
    // Check if we already have a worldId in localStorage
    const existingWorldId = localStorage.getItem(WORLD_ID_KEY);

    if (existingWorldId) {
      return existingWorldId as UUID;
    }

    // Create a new worldId if one doesn't exist
    const newWorldId = crypto.randomUUID() as UUID;
    localStorage.setItem(WORLD_ID_KEY, newWorldId);

    return newWorldId;
  },

  /**
   * Reset the world ID (mainly for testing purposes)
   */
  resetWorldId: (): UUID => {
    const newWorldId = crypto.randomUUID() as UUID;
    localStorage.setItem(WORLD_ID_KEY, newWorldId);
    return newWorldId;
  },

  /**
   * Get a room key that's specific to this world and agent
   */
  getRoomStorageKey: (agentId: UUID): string => {
    const worldId = WorldManager.getWorldId();
    return `room-${worldId}-${agentId}`;
  },
};

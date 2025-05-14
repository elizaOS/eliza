// File: /swarm/shared/ownership/core.ts
// Updated to use world metadata instead of cache

import { createUniqueUuid } from './entities';
import { logger } from './logger';
import { type IAgentRuntime, Role, type World } from './types';

/**
 * Represents the state of server ownership, including a mapping of server IDs to their respective World objects.
 */
/**
 * Interface representing the ownership state of servers.
 * @property {Object.<string, World>} servers - The servers and their corresponding worlds, where the key is the server ID and the value is the World object.
 */
export interface ServerOwnershipState {
  servers: {
    [serverId: string]: World;
  };
}

/**
 * Gets a user's role from world metadata
 */
/**
 * Retrieve the server role of a specified user entity within a given server.
 *
 * @param {IAgentRuntime} runtime - The runtime object containing necessary configurations and services.
 * @param {string} entityId - The unique identifier of the user entity.
 * @param {string} serverId - The unique identifier of the server.
 * @returns {Promise<Role>} The role of the user entity within the server, resolved as a Promise.
 */
export async function getUserServerRole(
  runtime: IAgentRuntime,
  entityId: string,
  serverId: string
): Promise<Role> {
  const worldId = createUniqueUuid(runtime, serverId);
  const world = await runtime.getWorld(worldId);

  if (!world || !world.metadata?.roles) {
    return Role.NONE;
  }

  if (world.metadata.roles[entityId]) {
    return world.metadata.roles[entityId] as Role;
  }

  // Also check original ID format
  if (world.metadata.roles[entityId]) {
    return world.metadata.roles[entityId] as Role;
  }

  return Role.NONE;
}

/**
 * Finds a server where the given user is the owner
 */
export async function findWorldsForOwner(
  runtime: IAgentRuntime,
  entityId: string
): Promise<World[] | null> {
  if (!entityId) {
    logger.error('User ID is required to find server');
    return null;
  }

  // Get all worlds for this agent
  const worlds = await runtime.getAllWorlds();

  if (!worlds || worlds.length === 0) {
    logger.info('No worlds found for this agent');
    return null;
  }

  const ownerWorlds = [];
  // Find world where the user is the owner
  for (const world of worlds) {
    if (world.metadata?.ownership?.ownerId === entityId) {
      ownerWorlds.push(world);
    }
  }

  return ownerWorlds.length ? ownerWorlds : null;
}

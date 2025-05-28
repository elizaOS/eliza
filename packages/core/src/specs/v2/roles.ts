import {
  getUserServerRole as coreGetUserServerRole,
  findWorldsForOwner as coreFindWorldsForOwner,
} from '../../roles';
import { type IAgentRuntime, Role, type World } from './types';

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
  return coreGetUserServerRole(runtime as any, entityId, serverId);
}

/**
 * Finds a server where the given user is the owner
 */
export async function findWorldsForOwner(
  runtime: IAgentRuntime,
  entityId: string
): Promise<World[] | null> {
  return coreFindWorldsForOwner(runtime as any, entityId);
}

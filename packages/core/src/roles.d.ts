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
export declare function getUserServerRole(runtime: IAgentRuntime, entityId: string, serverId: string): Promise<Role>;
/**
 * Finds a server where the given user is the owner
 */
export declare function findWorldsForOwner(runtime: IAgentRuntime, entityId: string): Promise<World[] | null>;
//# sourceMappingURL=roles.d.ts.map
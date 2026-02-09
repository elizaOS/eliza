import {
  ChannelType,
  createUniqueUuid,
  logger,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from '@elizaos/core';
import { getCachedRoom, getCachedWorld } from './shared-cache';

/** Reusable empty result for no role scenarios */
const NO_ROLES_RESULT: ProviderResult = {
  data: { roles: [] },
  values: { roles: 'No role information available for this server.' },
  text: 'No role information available for this server.',
};

/**
 * A provider for retrieving and formatting the role hierarchy in a server.
 * @type {Provider}
 */
export const roleProvider: Provider = {
  name: 'ROLES',
  description: 'Roles in the server, default are OWNER, ADMIN and MEMBER (as well as NONE)',
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    // Early validation - fail fast before any IO
    if (!message.roomId) {
      return NO_ROLES_RESULT;
    }

    // Use shared cache for room lookup - this ensures all providers share the same
    // in-flight promise and cached result, preventing redundant DB calls
    const room = await getCachedRoom(runtime, message.roomId);
    if (!room) {
      throw new Error('No room found');
    }

    // Early return for non-group contexts
    if (room.type !== ChannelType.GROUP) {
      return {
        data: { roles: [] },
        values: {
          roles:
            'No access to role information in DMs, the role provider is only available in group scenarios.',
        },
        text: 'No access to role information in DMs, the role provider is only available in group scenarios.',
      };
    }

    const serverId = room.serverId ?? room.messageServerId;
    if (!serverId) {
      logger.warn(
        { src: 'plugin:bootstrap:provider:roles', agentId: runtime.agentId, roomId: room.id },
        'No server ID found for room'
      );
      return {
        data: { roles: [] },
        values: { roles: 'No role information available - server ID not found.' },
        text: 'No role information available - server ID not found.',
      };
    }

    logger.info(
      { src: 'plugin:bootstrap:provider:roles', agentId: runtime.agentId, serverId },
      'Using server ID'
    );

    // Get world data (with caching)
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await getCachedWorld(runtime, worldId);

    if (!world || !world.metadata?.ownership?.ownerId) {
      logger.info(
        { src: 'plugin:bootstrap:provider:roles', agentId: runtime.agentId, serverId },
        'No ownership data found for server, initializing empty role hierarchy'
      );
      return NO_ROLES_RESULT;
    }

    // Get roles from world metadata
    const roles = world.metadata.roles || {};
    const entityIds = Object.keys(roles) as UUID[];

    if (entityIds.length === 0) {
      logger.info(
        { src: 'plugin:bootstrap:provider:roles', agentId: runtime.agentId, serverId },
        'No roles found for server'
      );
      return NO_ROLES_RESULT;
    }

    logger.info(
      {
        src: 'plugin:bootstrap:provider:roles',
        agentId: runtime.agentId,
        roleCount: entityIds.length,
      },
      'Found roles'
    );

    // Batch fetch all entities at once using runtime's batch method (single DB query)
    const entities = await runtime.getEntitiesByIds(entityIds);

    // Build entity map for O(1) lookup
    const entityMap = new Map<UUID, Entity>();
    if (entities) {
      for (const entity of entities) {
        if (entity.id) {
          entityMap.set(entity.id, entity);
        }
      }
    }

    // Use Set for O(1) duplicate checking instead of O(n) array.some()
    const seenUsernames = new Set<string>();

    // Group users by role
    const owners: { name: string; username: string; names: string[] }[] = [];
    const admins: { name: string; username: string; names: string[] }[] = [];
    const members: { name: string; username: string; names: string[] }[] = [];

    // Process roles using the pre-fetched entities
    for (const entityId of entityIds) {
      const userRole = roles[entityId];
      const user = entityMap.get(entityId);

      const name = user?.metadata?.name as string;
      const username = user?.metadata?.username as string;
      const userNames = user?.names as string[];

      // Skip if missing required fields
      if (!name || !username || !userNames) {
        logger.warn(
          { src: 'plugin:bootstrap:provider:roles', agentId: runtime.agentId, entityId },
          'User has no name or username, skipping'
        );
        continue;
      }

      // Skip duplicates using Set (O(1) lookup)
      if (seenUsernames.has(username)) {
        continue;
      }
      seenUsernames.add(username);

      // Add to appropriate group
      const userData = { name, username, names: userNames };
      switch (userRole) {
        case 'OWNER':
          owners.push(userData);
          break;
        case 'ADMIN':
          admins.push(userData);
          break;
        default:
          members.push(userData);
          break;
      }
    }

    // Early return if no valid users found
    if (owners.length === 0 && admins.length === 0 && members.length === 0) {
      return NO_ROLES_RESULT;
    }

    // Format the response using string builder pattern
    const parts: string[] = ['# Server Role Hierarchy\n'];

    if (owners.length > 0) {
      parts.push('## Owners');
      for (const owner of owners) {
        parts.push(`${owner.name} (${owner.names.join(', ')})`);
      }
      parts.push('');
    }

    if (admins.length > 0) {
      parts.push('## Administrators');
      for (const admin of admins) {
        parts.push(`${admin.name} (${admin.names.join(', ')}) (${admin.username})`);
      }
      parts.push('');
    }

    if (members.length > 0) {
      parts.push('## Members');
      for (const member of members) {
        parts.push(`${member.name} (${member.names.join(', ')}) (${member.username})`);
      }
    }

    const response = parts.join('\n');

    return {
      data: { roles: response },
      values: { roles: response },
      text: response,
    };
  },
};

export default roleProvider;

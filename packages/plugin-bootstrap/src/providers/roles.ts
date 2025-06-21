import {
  ChannelType,
  createUniqueUuid,
  logger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  type UUID,
} from '@elizaos/core';

/**
 * Role provider that retrieves roles in the server based on the provided runtime, message, and state.
 * * @type { Provider }
 * @property { string } name - The name of the role provider.
 * @property { string } description - A brief description of the role provider.
 * @property { Function } get - Asynchronous function that retrieves and processes roles in the server.
 * @param { IAgentRuntime } runtime - The agent runtime object.
 * @param { Memory } message - The message memory object.
 * @param { State } state - The state object.
 * @returns {Promise<ProviderResult>} The result containing roles data, values, and text.
 */
/**
 * A provider for retrieving and formatting the role hierarchy in a server.
 * @type {Provider}
 */
export const roleProvider: Provider = {
  name: 'ROLES',
  description: 'Roles in the server, default are OWNER, ADMIN and MEMBER (as well as NONE)',
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error('No room found');
    }

    if (room.type !== ChannelType.GROUP) {
      return {
        data: {
          roles: [],
        },
        values: {
          roles:
            'No access to role information in DMs, the role provider is only available in group scenarios.',
        },
        text: 'No access to role information in DMs, the role provider is only available in group scenarios.',
      };
    }

    const serverId = room.serverId;

    if (!serverId) {
      throw new Error('No server ID found');
    }

    logger.info(`Using server ID: ${serverId}`);

    // Get world data instead of using cache
    const worldId = createUniqueUuid(runtime, serverId);
    const world = await runtime.getWorld(worldId);

    if (!world || !world.metadata?.ownership?.ownerId) {
      logger.info(
        `No ownership data found for server ${serverId}, initializing empty role hierarchy`
      );
      return {
        data: {
          roles: [],
        },
        values: {
          roles: 'No role information available for this server.',
        },
        text: 'No role information available for this server.',
      };
    }
    // Get roles from world metadata
    const roles = world.metadata.roles || {};

    if (Object.keys(roles).length === 0) {
      logger.info(`No roles found for server ${serverId}`);
      return {
        data: {
          roles: [],
        },
        values: {
          roles: 'No role information available for this server.',
        },
        text: 'No role information available for this server.',
      };
    }

    logger.info(`Found ${Object.keys(roles).length} roles`);

    // Group users by role
    const owners: { name: string; username: string; names: string[] }[] = [];
    const admins: { name: string; username: string; names: string[] }[] = [];
    const members: { name: string; username: string; names: string[] }[] = [];

    // Process roles
    for (const entityId of Object.keys(roles) as UUID[]) {
      const userRole = roles[entityId];

      // get the user from the database
      const user = await runtime.getEntityById(entityId);

      const name = user?.metadata?.name as string;
      const username = user?.metadata?.username as string;
      const names = user?.names as string[];

      // Skip duplicates (we store both UUID and original ID)
      if (
        owners.some((owner) => owner.username === username) ||
        admins.some((admin) => admin.username === username) ||
        members.some((member) => member.username === username)
      ) {
        continue;
      }

      if (!name || !username || !names) {
        logger.warn(`User ${entityId} has no name or username, skipping`);
        continue;
      }

      // Add to appropriate group
      switch (userRole) {
        case 'OWNER':
          owners.push({ name, username, names });
          break;
        case 'ADMIN':
          admins.push({ name, username, names });
          break;
        default:
          members.push({ name, username, names });
          break;
      }
    }

    // Format the response
    let response = '# Server Role Hierarchy\n\n';

    if (owners.length > 0) {
      response += '## Owners\n';
      owners.forEach((owner) => {
        response += `${owner.name} (${owner.names.join(', ')})\n`;
      });
      response += '\n';
    }

    if (admins.length > 0) {
      response += '## Administrators\n';
      admins.forEach((admin) => {
        response += `${admin.name} (${admin.names.join(', ')}) (${admin.username})\n`;
      });
      response += '\n';
    }

    if (members.length > 0) {
      response += '## Members\n';
      members.forEach((member) => {
        response += `${member.name} (${member.names.join(', ')}) (${member.username})\n`;
      });
    }

    if (owners.length === 0 && admins.length === 0 && members.length === 0) {
      return {
        data: {
          roles: [],
        },
        values: {
          roles: 'No role information available for this server.',
        },
        text: 'No role information available for this server.',
      };
    }

    return {
      data: {
        roles: response,
      },
      values: {
        roles: response,
      },
      text: response,
    };
  },
};

export default roleProvider;

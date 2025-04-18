import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  createUniqueUuid,
  type UUID,
  logger,
} from '@elizaos/core';

interface TeamMember {
  section: string;
  tgName?: string;
  discordName?: string;
  format: string;
  serverId: string;
  serverName?: string;
  createdAt?: string;
  updatesConfig?: {
    fields: string[];
  };
}

/**
 * Creates a consistent room ID for team members storage
 * @param runtime The agent runtime
 * @param serverId The server ID
 * @returns A consistent room ID string
 */
function getStorageRoomId(runtime: IAgentRuntime, serverId: string): UUID {
  // Create a consistent hash based on serverId
  const serverHash = serverId.replace(/[^a-zA-Z0-9]/g, '');
  return createUniqueUuid(runtime, `store-team-members-${serverHash}`);
}

export const listTeamMembersAction: Action = {
  name: 'LIST_TEAM_MEMBERS',
  description: 'List all team members that have been registered in the system.',
  similes: ['LIST_TEAM_MEMBERS', 'SHOW_TEAM', 'VIEW_MEMBERS', 'GET_TEAM_LIST', 'DISPLAY_TEAM'],
  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      // Basic validation
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      logger.info('Room data:', JSON.stringify(room, null, 2));

      if (!room) {
        logger.error('No room found for message');
        return false;
      }

      const serverId = room.serverId;
      if (!serverId) {
        logger.error('No server ID found for room');
        return false;
      }

      // Store server ID in state for the handler
      state.data.serverId = serverId;
      state.data.serverName = room.name || 'Unknown Server';

      logger.info(`Valid request to list team members for server ${serverId}`);
      return true;
    } catch (error) {
      logger.error('Error in listTeamMembersAction validation:', error);
      logger.error(`Error stack: ${error.stack}`);
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== LIST-TEAM-MEMBERS HANDLER START ===');

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Get server ID from state
      const serverId = state.data.serverId as string;
      const serverName = state.data.serverName as string;

      if (!serverId) {
        logger.error('No server ID found in state');
        await callback(
          {
            text: '❌ Failed to identify the server. Please try again.',
          },
          []
        );
        return false;
      }

      logger.info(`Fetching team members for server: ${serverId} (${serverName})`);

      // FIXED: Get the correct room ID for storing team members
      const serverHash = serverId.replace(/[^a-zA-Z0-9]/g, '');
      const roomIdForStoringTeamMembers = createUniqueUuid(
        runtime,
        `store-team-members-${serverHash}`
      );

      logger.info(`Looking for team members in room: ${roomIdForStoringTeamMembers}`);

      // Get memories from the team members storage room
      const memories = await runtime.getMemories({
        roomId: roomIdForStoringTeamMembers,
        tableName: 'messages',
      });

      logger.info(`Found ${memories.length} memories in room ${roomIdForStoringTeamMembers}`);

      // Find the team members config memory
      const teamMembersConfig = memories.find(
        (memory) => memory.content?.type === 'store-team-members-memory'
      );

      if (!teamMembersConfig || !teamMembersConfig.content?.config?.teamMembers) {
        logger.info('No team members found for this server');
        await callback(
          {
            text: '📋 No team members have been registered yet for this server.',
          },
          []
        );
        return true;
      }

      // Extract and format team members
      const teamMembers = teamMembersConfig.content.config.teamMembers as TeamMember[];
      logger.info(`Found ${teamMembers.length} team members for server ${serverId}`);

      if (teamMembers.length === 0) {
        await callback(
          {
            text: '📋 No team members have been registered yet for this server.',
          },
          []
        );
        return true;
      }

      // Group team members by section
      const sectionMap = new Map<string, TeamMember[]>();
      teamMembers.forEach((member) => {
        const section = member.section || 'Unassigned';
        if (!sectionMap.has(section)) {
          sectionMap.set(section, []);
        }
        sectionMap.get(section)?.push(member);
      });

      // Format the response
      let responseText = `📋 **Team Members for ${serverName}**\n\n`;

      Array.from(sectionMap.entries()).forEach(([section, members]) => {
        responseText += `**${section}** (${members.length}):\n`;

        members.forEach((member, index) => {
          let memberInfo = `${index + 1}. `;

          if (member.tgName) {
            memberInfo += `Telegram: ${member.tgName}`;
          } else if (member.discordName) {
            memberInfo += `Discord: ${member.discordName}`;
          } else {
            memberInfo += 'Unknown platform';
          }

          memberInfo += ` | Format: ${member.format || 'Text'}`;

          if (member.updatesConfig?.fields && member.updatesConfig.fields.length > 0) {
            memberInfo += ` | Update Fields: ${member.updatesConfig.fields.join(', ')}`;
          }

          responseText += `${memberInfo}\n`;
        });

        responseText += '\n';
      });

      // Send the response
      await callback(
        {
          text: responseText.trim(),
        },
        []
      );

      logger.info('=== LIST-TEAM-MEMBERS HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== LIST-TEAM-MEMBERS HANDLER ERROR ===');
      logger.error(`Error listing team members: ${error}`);
      logger.error(`Error stack: ${error.stack}`);

      if (callback) {
        await callback(
          {
            text: '❌ An unexpected error occurred while retrieving team members. Please try again later.',
          },
          []
        );
      }
      return false;
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show me all team members',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "Here's a list of all registered team members",
          actions: ['LIST_TEAM_MEMBERS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Who is in my team?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll show you the team members list",
          actions: ['LIST_TEAM_MEMBERS'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'List all team members by section',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "Here's the team organization by section",
          actions: ['LIST_TEAM_MEMBERS'],
        },
      },
    ],
  ],
};

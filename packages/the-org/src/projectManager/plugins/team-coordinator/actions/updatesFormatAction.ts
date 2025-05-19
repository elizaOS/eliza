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
  updatesFormat?: string[];
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

export const updatesFormatAction: Action = {
  name: 'UPDATES_FORMAT',
  description: 'Show the updates format for a specific team member.',
  similes: ['UPDATES_FORMAT', 'SHOW_FORMAT', 'GET_FORMAT', 'MY_FORMAT', 'VIEW_FORMAT'],
  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      // Store the username in state for the handler
      state.data.username = message.name;
      state.data.userId = message.entityId;

      logger.info(`Valid request to get updates format for user ${message.name}`);
      return true;
    } catch (error) {
      logger.error('Error in updatesFormatAction validation:', error);
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
      logger.info('=== UPDATES-FORMAT HANDLER START ===');

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      const entityById = await runtime.getEntityById(message.entityId);

      const username =
        entityById?.metadata?.discord?.userName || entityById?.metadata?.telegram?.userName;

      // Log the telegram and discord metadata for debugging
      logger.info(
        'Entity metadata - Telegram:',
        JSON.stringify(entityById?.metadata?.telegram || 'Not available')
      );
      logger.info(
        'Entity metadata - Discord:',
        JSON.stringify(entityById?.metadata?.discord || 'Not available')
      );

      if (!username) {
        logger.error('No username found in state');
        await callback(
          {
            text: '❌ Failed to identify your username. Please try again.',
          },
          []
        );
        return false;
      }

      logger.info(`Looking for updates format for user: ${username}`);

      // Get all memories using agentId since roomId is not available
      const allMemories = await runtime.getMemories({
        tableName: 'messages',
        agentId: runtime.agentId,
      });

      logger.info(`Found ${allMemories.length} total memories`);

      // Filter to get only team member configs
      const teamMemberConfigs = allMemories.filter(
        (memory) => memory.content?.type === 'store-team-members-memory'
      );

      logger.info(`Found ${teamMemberConfigs.length} team member config memories`);

      // Initialize an empty array for all team members across all servers
      let allTeamMembers: TeamMember[] = [];

      // Extract all team members from all configs
      teamMemberConfigs.forEach((config) => {
        if (config.content?.config?.teamMembers) {
          const teamMembers = config.content.config.teamMembers as TeamMember[];
          logger.info(`Found ${teamMembers.length} team members in config`);
          allTeamMembers = [...allTeamMembers, ...teamMembers];
        }
      });

      logger.info(`Total of ${allTeamMembers.length} team members found across all servers`);

      // Log team members and username for debugging
      logger.info(
        `Looking for username: ${username} among team members:`,
        allTeamMembers.map((member) => ({
          tgName: member.tgName,
          discordName: member.discordName,
        }))
      );

      // Try to find the team member by username
      const teamMember = allTeamMembers.find(
        (member) =>
          (member.tgName &&
            (member.tgName === username ||
              member.tgName?.replace('@', '') === username.replace('@', ''))) ||
          (member.discordName && member.discordName.replace('@', '') === username.replace('@', ''))
      );

      if (!teamMember) {
        logger.info(`No team member found with username ${username}`);
        await callback(
          {
            text: `❌ No team member found with username ${username}. Please make sure you are registered as a team member.`,
          },
          []
        );
        return true;
      }

      logger.info(`Found team member: ${JSON.stringify(teamMember)}`);

      // Format the response
      let responseText = `📋 **Updates Format for ${username}**\n\n`;

      responseText += `Section: ${teamMember.section || 'Unassigned'}\n`;

      if (teamMember.updatesFormat && teamMember.updatesFormat.length > 0) {
        responseText += `\nYour updates should include the following fields:\n`;
        teamMember.updatesFormat.forEach((field, index) => {
          responseText += `${index + 1}. ${field}\n`;
        });
        responseText += `\nImportant: End your message with "sending my personal updates" so it can be properly tracked.`;
      } else {
        responseText +=
          `\nYou don't have any specific update format fields defined. Please use the standard format for your updates:\n\n` +
          `- **Main Priority for next week**\n` +
          `    - Text\n` +
          `- **What did you get done this week?**\n` +
          `    - Text\n` +
          `- **Blockers**\n` +
          `    - Text\n\n` +
          `Important: End your message with "sending my personal updates" so it can be properly tracked.`;
      }

      await callback(
        {
          text: responseText,
        },
        []
      );

      logger.info('=== UPDATES-FORMAT HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== UPDATES-FORMAT HANDLER ERROR ===');
      logger.error(`Error processing updates format request: ${error}`);
      logger.error(`Error stack: ${error.stack}`);

      if (callback) {
        await callback(
          {
            text: '❌ An unexpected error occurred while fetching your updates format. Please try again later.',
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
          text: 'What is my updates format?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll show you your updates format",
          actions: ['UPDATES_FORMAT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Show me my updates format',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: 'Let me fetch your updates format',
          actions: ['UPDATES_FORMAT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'How should I format my updates?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll get the format for your updates",
          actions: ['UPDATES_FORMAT'],
        },
      },
    ],
  ],
};

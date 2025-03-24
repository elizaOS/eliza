import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';

interface TeamMemberUpdate {
  type: 'team-member-update';
  updateId: UUID;
  teamMemberId: UUID;
  currentProgress: string;
  workingOn: string;
  nextSteps: string;
  blockers: string;
  eta: string;
  timestamp: string;
  channelId?: UUID;
}

/**
 * Formats a team member update for display
 * @param update The team member update to format
 * @returns Formatted string of the update
 */
function formatUpdateForDisplay(update: TeamMemberUpdate): string {
  const date = new Date(update.timestamp).toLocaleString();

  return `**Update from ${date}**
  
**Current Progress:** ${update.currentProgress}
**Working On:** ${update.workingOn}
**Next Steps:** ${update.nextSteps}
**Blockers:** ${update.blockers}
**ETA:** ${update.eta}
`;
}

/**
 * Retrieves team member updates from memory
 * @param runtime The agent runtime
 * @param teamMemberId The ID of the team member
 * @returns Array of team member updates
 */
async function getTeamMemberUpdates(
  runtime: IAgentRuntime,
  teamMemberId: UUID
): Promise<TeamMemberUpdate[]> {
  try {
    logger.info('=== GET TEAM MEMBER UPDATES START ===');
    logger.info(`Retrieving updates for team member: ${teamMemberId}`);

    // Get all memories from all rooms for this entity
    const memories = await runtime.getMemories({
      entityId: teamMemberId,
      tableName: 'messages',
    });

    logger.info(`Found ${memories.length} memories for team member`);

    // Filter for team member updates
    const updates = memories
      .filter(
        (memory) =>
          memory.content?.type === 'team-member-update' &&
          memory.content?.update?.teamMemberId === teamMemberId
      )
      .map((memory) => memory.content?.update as TeamMemberUpdate)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Sort newest first

    logger.info(`Filtered to ${updates.length} team member updates`);
    logger.info('=== GET TEAM MEMBER UPDATES END ===');

    return updates;
  } catch (error) {
    logger.error('=== GET TEAM MEMBER UPDATES ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return [];
  }
}

export const listTeamMemberUpdates: Action = {
  name: 'listTeamMemberUpdates',
  description: 'Lists all updates provided by a team member',
  similes: ['getMyUpdates', 'showMyUpdates', 'viewTeamMemberUpdates', 'fetchMyUpdates'],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('Validating listTeamMemberUpdates action:', {
      messageId: message.id,
      entityId: message.entityId,
    });

    // Check if the message has an entity ID (team member ID)
    if (!message.entityId) {
      logger.warn('No entity ID found in message');
      return false;
    }

    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== LIST TEAM MEMBER UPDATES HANDLER START ===');
      logger.info('Handler details:', {
        messageId: message.id,
        entityId: message.entityId,
        hasCallback: !!callback,
      });

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      if (!message.entityId) {
        logger.warn('No entity ID found in message');
        await callback(
          {
            text: '❌ I could not identify you. Please try again.',
            source: 'discord',
          },
          []
        );
        return false;
      }

      // Get updates for the team member
      const updates = await getTeamMemberUpdates(runtime, message.entityId);

      if (updates.length === 0) {
        logger.info('No updates found for team member');
        await callback(
          {
            text: 'You have not submitted any updates yet.',
            source: 'discord',
          },
          []
        );
        return true;
      }

      // Format the updates for display
      const limit = 5; // Limit to the 5 most recent updates
      const recentUpdates = updates.slice(0, limit);

      let responseText = `Here are your ${recentUpdates.length} most recent updates:\n\n`;
      responseText += recentUpdates.map(formatUpdateForDisplay).join('\n---\n\n');

      if (updates.length > limit) {
        responseText += `\n\n*Showing ${limit} of ${updates.length} total updates.*`;
      }

      // Send the response
      const content: Content = {
        text: responseText,
        source: 'discord',
      };

      logger.info(`Sending ${recentUpdates.length} updates to user`);
      await callback(content, []);
      logger.info('=== LIST TEAM MEMBER UPDATES HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== LIST TEAM MEMBER UPDATES HANDLER ERROR ===');
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      if (callback) {
        await callback(
          {
            text: '❌ An error occurred while retrieving your updates. Please try again.',
            source: 'discord',
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
        name: 'team-member',
        content: {
          text: 'Show me my updates',
        },
      },
      {
        name: 'jimmy',
        content: {
          text: 'Here are your most recent updates: [formatted updates]',
          actions: ['listTeamMemberUpdates'],
        },
      },
    ],
    [
      {
        name: 'developer',
        content: {
          text: 'What updates have I submitted?',
        },
      },
      {
        name: 'jimmy',
        content: {
          text: 'Here are your most recent updates: [formatted updates]',
          actions: ['listTeamMemberUpdates'],
        },
      },
    ],
  ],
};

import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  type MemoryMetadata,
  MemoryType,
  createUniqueUuid,
  logger,
  asUUID,
  type Service,
} from '@elizaos/core';

interface TeamMemberUpdate {
  type: 'team-member-update';
  updateId: UUID;
  teamMemberId: UUID;
  teamMemberName?: string;
  currentProgress: string;
  workingOn: string;
  nextSteps: string;
  blockers: string;
  eta: string;
  timestamp: string;
  channelId?: UUID;
  serverId?: string;
}

// Define a simple interface for the Discord service
interface IDiscordService extends Service {
  client: {
    guilds: {
      cache: Map<
        string,
        {
          name: string;
          channels: {
            fetch: () => Promise<{
              find: (
                predicate: (channel: Record<string, unknown>) => boolean
              ) => Record<string, unknown> | undefined;
            }>;
          };
        }
      >;
    };
  };
}

/**
 * Posts team member update to the configured Discord channel for the server
 */
async function postUpdateToDiscordChannel(
  runtime: IAgentRuntime,
  update: TeamMemberUpdate
): Promise<boolean> {
  try {
    logger.info('=== POST TEAM MEMBER UPDATE TO DISCORD START ===');

    // Get the Discord service
    const discordService = runtime.getService('discord') as IDiscordService | null;
    if (!discordService) {
      logger.error('Discord service not available');
      return false;
    }

    logger.info('Discord service retrieved successfully');

    // Get report channel config
    const roomId = createUniqueUuid(runtime, 'report-channel-config');
    logger.info('Generated roomId for config:', roomId);

    const memories = await runtime.getMemories({
      roomId: roomId as UUID,
      tableName: 'messages',
    });

    logger.info('Retrieved report channel configs:', {
      count: memories.length,
    });

    // Find config for this server
    const config = memories.find((memory) => memory.content?.type === 'report-channel-config');

    if (!config) {
      logger.warn('No report channel config found');
      return false;
    }

    logger.info('Found report channel config:', config);

    const channelId = config.content?.config?.channelId;
    if (!channelId) {
      logger.warn('No channel ID in config');
      return false;
    }

    // Format the update message
    const formattedDate = new Date(update.timestamp).toLocaleString();
    logger.info('Formatting update message with timestamp:', {
      timestamp: update.timestamp,
      formatted: formattedDate,
    });

    const updateMessage = `## Team Member Update
**Team Member**: ${update.teamMemberName || 'Unknown'} (${update.teamMemberId})
**Timestamp**: ${formattedDate}

**Current Progress**: ${update.currentProgress}
**Working On**: ${update.workingOn}
**Next Steps**: ${update.nextSteps}
**Blockers**: ${update.blockers}
**ETA**: ${update.eta}`;

    logger.info('Formatted update message:', { messageLength: updateMessage.length });

    // Get Discord client
    const client = discordService.client;
    if (!client) {
      logger.error('Discord client not available');
      return false;
    }

    // Get all guilds/servers
    const guilds = client.guilds.cache;
    logger.info(`Found ${guilds.size} Discord servers`);

    let targetChannel = null;

    // Find the configured channel
    for (const guild of guilds.values()) {
      logger.info(`Searching for channel ${channelId} in server: ${guild.name}`);

      const channels = await guild.channels.fetch();

      const channel = channels.find((ch) => {
        return ch && typeof ch === 'object' && 'id' in ch && ch.id === channelId;
      });

      if (channel) {
        logger.info(`Found target channel in server: ${guild.name}`);
        targetChannel = channel;
        break;
      }
    }

    if (!targetChannel) {
      logger.warn(`Could not find Discord channel with ID ${channelId}`);
      return false;
    }

    // Send the message
    logger.info('Attempting to send update to Discord channel');
    await (
      targetChannel as Record<string, unknown> & { send: (content: string) => Promise<unknown> }
    ).send(updateMessage);

    logger.info('Successfully sent team member update to Discord');
    logger.info('=== POST TEAM MEMBER UPDATE TO DISCORD END ===');
    return true;
  } catch (error) {
    logger.error('=== POST TEAM MEMBER UPDATE TO DISCORD ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return false;
  }
}

async function storeTeamMemberUpdate(
  runtime: IAgentRuntime,
  update: TeamMemberUpdate
): Promise<boolean> {
  try {
    logger.info('=== STORE TEAM MEMBER UPDATE START ===');
    logger.info('Storing update for team member:', {
      teamMemberId: update.teamMemberId,
      updateId: update.updateId,
      timestamp: update.timestamp,
    });

    // Use the existing room ID from the message instead of creating a new one
    // This resolves the foreign key constraint error
    const roomId = update.channelId;
    logger.info(`Using existing room ID: ${roomId}`);

    if (!roomId) {
      logger.error('No room ID available for storing the update');
      return false;
    }

    // Store the update in memory
    logger.info('Attempting to store update in memory...');
    const memory: Memory = {
      id: createUniqueUuid(runtime, `team-update-${Date.now()}`),
      agentId: runtime.agentId,
      roomId: roomId,
      entityId: asUUID(update.teamMemberId),
      content: {
        type: 'team-member-update',
        update,
      },
      metadata: {
        type: MemoryType.CUSTOM,
        timestamp: Date.now(),
      },
    };

    await runtime.createMemory(memory, 'messages');

    logger.info('Successfully stored team member update');
    logger.info('=== STORE TEAM MEMBER UPDATE END ===');
    return true;
  } catch (error) {
    logger.error('=== STORE TEAM MEMBER UPDATE ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return false;
  }
}

function parseTeamMemberUpdate(runtime: IAgentRuntime, message: Memory): TeamMemberUpdate | null {
  try {
    logger.info('=== PARSE TEAM MEMBER UPDATE START ===');
    logger.info('Parsing update from message:', {
      messageId: message.id,
      entityId: message.entityId,
    });

    const text = message.content?.text as string;
    if (!text) {
      logger.warn('No text content found in message');
      return null;
    }

    logger.info('Message text content length:', text.length);

    // Check if the message ends with the required marker
    if (!text.toLowerCase().includes('sending my updates')) {
      logger.warn('Message does not end with required marker "sending my updates"');
      return null;
    }

    // Extract sections from the text
    const currentProgressMatch = text.match(/Current Progress:(.+?)(?=Working On:|$)/s);
    const workingOnMatch = text.match(/Working On:(.+?)(?=Next Steps:|$)/s);
    const nextStepsMatch = text.match(/Next Steps:(.+?)(?=Blockers:|$)/s);
    const blockersMatch = text.match(/Blockers:(.+?)(?=ETA:|$)/s);
    const etaMatch = text.match(/ETA:(.+?)(?=sending my updates|$)/is);

    logger.info('Extracted sections from message:', {
      hasCurrentProgress: !!currentProgressMatch,
      hasWorkingOn: !!workingOnMatch,
      hasNextSteps: !!nextStepsMatch,
      hasBlockers: !!blockersMatch,
      hasEta: !!etaMatch,
    });

    if (
      !currentProgressMatch ||
      !workingOnMatch ||
      !nextStepsMatch ||
      !blockersMatch ||
      !etaMatch
    ) {
      logger.warn('Message does not contain all required sections');
      return null;
    }

    // Get the user name from the message content
    let userName = 'Team Member';

    if (message.content) {
      if (typeof message.content.userName === 'string') {
        userName = message.content.userName;
      } else if (typeof message.content.name === 'string') {
        userName = message.content.name;
      }
    }

    logger.info('Found user name from message:', { userName });

    const update: TeamMemberUpdate = {
      type: 'team-member-update',
      updateId: createUniqueUuid(runtime, 'team-update'),
      teamMemberId: message.entityId || asUUID('unknown'),
      teamMemberName: userName,
      currentProgress: currentProgressMatch[1].trim(),
      workingOn: workingOnMatch[1].trim(),
      nextSteps: nextStepsMatch[1].trim(),
      blockers: blockersMatch[1].trim(),
      eta: etaMatch[1].trim(),
      timestamp: new Date().toISOString(),
      channelId: message.roomId,
      // serverId: message.content?.serverId,
    };

    logger.info('Successfully parsed team member update:', {
      updateId: update.updateId,
      teamMemberId: update.teamMemberId,
      teamMemberName: update.teamMemberName,
    });

    logger.info('=== PARSE TEAM MEMBER UPDATE END ===');
    return update;
  } catch (error) {
    logger.error('=== PARSE TEAM MEMBER UPDATE ERROR ===');
    logger.error('Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
    return null;
  }
}

export const recordTeamMemberUpdates: Action = {
  name: 'recordTeamMemberUpdates',
  description: 'Records updates provided by team members for future reference',
  similes: ['saveTeamUpdate', 'trackTeamProgress', 'logTeamUpdate'],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('Validating recordTeamMemberUpdates action:', {
      messageId: message.id,
      entityId: message.entityId,
    });

    const text = message.content?.text as string;
    if (!text) {
      logger.warn('No text content found in message');
      return false;
    }

    // Check if the message contains the required format and marker
    const hasRequiredSections =
      text.includes('Current Progress:') &&
      text.includes('Working On:') &&
      text.includes('Next Steps:') &&
      text.includes('Blockers:') &&
      text.includes('ETA:');

    const hasMarker = text.toLowerCase().includes('sending my updates');

    logger.info('Validation results:', {
      hasRequiredSections,
      hasMarker,
    });

    return hasRequiredSections && hasMarker;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: Record<string, unknown>,
    context: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('=== RECORD TEAM MEMBER UPDATES HANDLER START ===');
      logger.info('Handler details:', {
        messageId: message.id,
        entityId: message.entityId,
        hasCallback: !!callback,
        stateKeys: Object.keys(state),
        contextKeys: Object.keys(context),
      });
      logger.info('Processing message:', {
        id: message.id,
        content: JSON.stringify(message.content),
        entityId: message.entityId,
        roomId: message.roomId,
        timestamp: message.metadata?.timestamp,
        text: message.content?.text,
        type: message.content?.type,
        metadata: JSON.stringify(message.metadata),
        fullMessage: JSON.stringify(message),
      });

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Parse the update from the message
      const update = parseTeamMemberUpdate(runtime, message);
      if (!update) {
        logger.warn('Failed to parse team member update from message');
        await callback(
          {
            text: '❌ I was unable to process your update. Please make sure you followed the required format and ended with "sending my updates".',
            source: 'discord',
          },
          []
        );
        return false;
      }

      // Store the update in memory
      const stored = await storeTeamMemberUpdate(runtime, update);
      if (!stored) {
        logger.error('Failed to store team member update');
        await callback(
          {
            text: '❌ There was an error storing your update. Please try again later.',
            source: 'discord',
          },
          []
        );
        return false;
      }

      // Post update to configured Discord channel
      const posted = await postUpdateToDiscordChannel(runtime, update);
      if (posted) {
        logger.info('Successfully posted team member update to Discord');
      } else {
        logger.warn('Could not post update to Discord, but continuing with normal flow');
      }

      // Send confirmation
      const content: Content = {
        text: `✅ Thanks for your update! I've recorded your progress details.${posted ? ' Your update has been posted to the configured channel.' : ''}`,
        source: 'discord',
      };

      logger.info('Sending confirmation to user');
      await callback(content, []);
      logger.info('Successfully recorded team member update');
      logger.info('=== RECORD TEAM MEMBER UPDATES HANDLER END ===');
      return true;
    } catch (error) {
      logger.error('=== RECORD TEAM MEMBER UPDATES HANDLER ERROR ===');
      logger.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });

      if (callback) {
        await callback(
          {
            text: '❌ An error occurred while processing your update. Please try again.',
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
          text: `Current Progress: Completed the API integration
Working On: Testing the authentication flow
Next Steps: Deploy to staging environment
Blockers: None at the moment
ETA: End of day tomorrow

sending my updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: "Thanks for your update! I've recorded your progress details.",
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
    [
      {
        name: 'developer',
        content: {
          text: `Current Progress: Fixed 3 critical bugs in the frontend
Working On: Implementing the new dashboard features
Next Steps: Code review and documentation
Blockers: Waiting on design assets from the design team
ETA: Thursday EOD

sending my updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: 'Got it! Your progress has been recorded.',
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
  ],
};

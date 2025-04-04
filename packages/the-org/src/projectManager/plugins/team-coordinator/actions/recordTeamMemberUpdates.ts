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
  ModelType,
} from '@elizaos/core';
import type { TeamMemberUpdate } from '../../../types';

// Define a simple interface for the Discord service
interface IDiscordService extends Service {
  client: {
    users: {
      fetch: (userId: string) => Promise<{
        username: string;
        id: string;
      }>;
    };
    guilds: {
      cache: Map<
        string,
        {
          name: string;
          id: string;
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
      configs: memories.map((m) => ({
        type: m.content?.type,
        channelId: m.content?.config?.channelId,
      })),
    });

    // TODO : fetch server id of channel id

    // Get all guilds/servers
    const guilds = discordService.client.guilds.cache;
    logger.info(`Found ${guilds.size} Discord servers`);

    // Find the guild that matches the server name exactly
    let targetGuild = null;
    for (const guild of guilds.values()) {
      logger.info(`Checking guild: ${guild.name} against update server name: ${update.serverName}`);
      if (guild.name === update.serverName) {
        targetGuild = guild;
        logger.info(`Found matching guild: ${guild.name} with ID: ${guild.id}`);
        break;
      }
    }

    if (!targetGuild) {
      logger.warn(`Could not find Discord server matching exact name: ${update.serverName}`);
      return false;
    }

    // Find config for this server
    const config = memories.find((memory) => {
      const serverMatch = targetGuild?.id;
      logger.info(`Checking config:`, {
        configType: memory.content?.type,
        configServerId: memory.content?.config?.serverId,
        targetGuildId: targetGuild?.id,
        matches: serverMatch,
      });
      return memory.content?.type === 'report-channel-config' && serverMatch;
    });

    if (!config) {
      logger.warn(
        `No report channel config found for server: ${targetGuild.name} (${targetGuild.id})`
      );
      return false;
    }

    logger.info('Found report channel config:', {
      configId: config.id,
      configType: config.content?.type,
      configServerId: targetGuild?.id,
      configChannelId: config.content?.config?.channelId,
    });

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
**Server-name**: ${update.serverName}
**Check-in Type**: ${update.checkInType}
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

    // Find the configured channel in the target guild
    logger.info(`Searching for channel ${channelId} in server: ${targetGuild.name}`);
    const channels = await targetGuild.channels.fetch();

    const targetChannel = channels.find((ch) => {
      return ch && typeof ch === 'object' && 'id' in ch && ch.id === channelId;
    });

    if (!targetChannel) {
      logger.warn(
        `Could not find Discord channel with ID ${channelId} in server ${targetGuild.name}`
      );
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

async function parseTeamMemberUpdate(
  runtime: IAgentRuntime,
  message: Memory
): Promise<TeamMemberUpdate | null> {
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

    // Use AI to parse the update text
    const prompt = `Extract the following fields from this team member update text. The text will be in a specific format with "sharing my updates" at the start and "sending my updates" at the end.

    Return ONLY a valid JSON object with these exact keys:
    {
      "serverName": "value", // Extract server name after "Server-name:" ignoring the question text 
      "checkInType": "value", // Extract type after "Check-in Type:" ignoring the question text
      "currentProgress": "value", // Extract the line after "Current Progress:" ignoring the question text
      "workingOn": "value", // Extract the line after "Working On:" ignoring the question text
      "nextSteps": "value", // Extract the line after "Next Steps:" ignoring the question text
      "blockers": "value", // Extract the line after "Blockers:" ignoring the question text
      "eta": "value" // Extract the line after "ETA:" ignoring the question text
    }

    Note: 
    - checkInType must be one of: STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO
    - For each field, only extract the actual update text, not the question/description
    - Example: For "Current Progress: What you've accomplished recently\\njimmy", extract only "jimmy"

    Text to parse: "${text}"`;

    logger.info('Sending text to AI for parsing');
    logger.info('Prompt:', prompt);

    const parsedResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    });

    logger.info('Raw AI response:', parsedResponse);

    let parsedFields: Record<string, string>;
    try {
      // Remove any backticks or markdown formatting that might be in the response
      const cleanedResponse = parsedResponse.replace(/```json\n?|\n?```/g, '').trim();
      parsedFields = JSON.parse(cleanedResponse);
      logger.info('Successfully parsed fields from AI response:', parsedFields);
    } catch (error) {
      logger.error('Failed to parse AI response as JSON:', error);
      logger.error('Raw response that failed parsing:', parsedResponse);
      throw new Error('PARSING_ERROR: AI response was not valid JSON');
    }

    // Validate required fields
    const missingFields = [];
    const requiredFields = [
      'serverName',
      'checkInType',
      'currentProgress',
      'workingOn',
      'nextSteps',
      'blockers',
      'eta',
    ];

    for (const field of requiredFields) {
      if (!parsedFields[field]) {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      logger.warn('Missing required fields:', missingFields);
      throw new Error(`MISSING_FIELDS:${missingFields.join(',')}`);
    }

    // Get the user name from Discord
    const entityById = await runtime.getEntityById(message.entityId);
    const userName =
      entityById?.metadata?.discord?.userName || entityById?.metadata?.telegram?.name;

    const update: TeamMemberUpdate = {
      type: 'team-member-update',
      updateId: createUniqueUuid(runtime, 'team-update'),
      teamMemberId: message.entityId || asUUID('unknown'),
      teamMemberName: userName,
      serverName: parsedFields.serverName,
      checkInType: parsedFields.checkInType,
      currentProgress: parsedFields.currentProgress,
      workingOn: parsedFields.workingOn,
      nextSteps: parsedFields.nextSteps,
      blockers: parsedFields.blockers,
      eta: parsedFields.eta,
      timestamp: new Date().toISOString(),
      channelId: message.roomId,
    };

    logger.info('Successfully parsed team member update:', {
      type: 'team-member-update',
      updateId: createUniqueUuid(runtime, 'team-update'),
      teamMemberId: message.entityId || asUUID('unknown'),
      teamMemberName: userName,
      serverName: parsedFields.serverName,
      checkInType: parsedFields.checkInType,
      currentProgress: parsedFields.currentProgress,
      workingOn: parsedFields.workingOn,
      nextSteps: parsedFields.nextSteps,
      blockers: parsedFields.blockers,
      eta: parsedFields.eta,
      timestamp: new Date().toISOString(),
      channelId: message.roomId,
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
    throw error; // Propagate the error to handle it in the handler
  }
}

export const recordTeamMemberUpdates: Action = {
  name: 'recordTeamMemberUpdates',
  description:
    'Records individual status updates sent by team members with their progress details, blockers, and ETAs [MEMBER-STATUS-UPDATE]',
  similes: [
    'logIndividualUpdate',
    'submitMemberStatus',
    'saveProgressUpdate',
    'trackMemberWork',
    'memberProgressLog',
    'submitStatusDetails',
    'sendPersonalUpdate',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info('whole message ', JSON.stringify(message));

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
      text.includes('Server-name:') &&
      text.includes('Check-in Type:') &&
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
      try {
        const update = await parseTeamMemberUpdate(runtime, message);
        if (!update) {
          const template = `Please provide your update using the following format:

Server-name: [server name]
Check-in Type: [daily/weekly/sprint]
Current Progress: [what you've completed]
Working On: [current tasks]
Next Steps: [upcoming tasks]
Blockers: [any blockers or "none"]
ETA: [expected completion time]

End your message with "sending my updates"`;

          await callback(
            {
              text: `❌ I was unable to process your update. ${template}`,
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
        if (error.message.startsWith('MISSING_FIELDS:')) {
          const missingFields = error.message.split(':')[1].split(',');
          const missingFieldsList = missingFields.join(', ');

          await callback(
            {
              text: `❌ Your update is missing the following required fields: ${missingFieldsList}\n\nPlease include all required fields and try again:
• Server-name
• Check-in Type
• Current Progress
• Working On
• Next Steps
• Blockers
• ETA

Remember to end your message with "sending my updates"`,
              source: 'discord',
            },
            []
          );
          return false;
        }

        // Handle other errors
        logger.error('Unexpected error:', error);
        await callback(
          {
            text: '❌ An error occurred while processing your update. Please try again.',
            source: 'discord',
          },
          []
        );
        return false;
      }
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
          text: `[INDIVIDUAL STATUS UPDATE]
Server-name: Development Server
Check-in Type: Daily
Current Progress: Completed the API integration
Working On: Testing the authentication flow
Next Steps: Deploy to staging environment
Blockers: None at the moment
ETA: End of day tomorrow

sending my personal updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: "✅ Thank you for your individual status update! I've recorded your progress details and will share them with the team.",
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
    [
      {
        name: 'developer',
        content: {
          text: `[MEMBER PROGRESS REPORT]
Server-name: Project X Server
Check-in Type: SPRINT
Current Progress: Fixed 3 critical bugs in the frontend
Working On: Implementing the new dashboard features
Next Steps: Code review and documentation
Blockers: Waiting on design assets from the design team
ETA: Thursday EOD

sending my personal updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: '✅ Your personal status has been logged successfully. I will make sure the team is aware of your progress and blockers.',
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
    [
      {
        name: 'developer',
        content: {
          text: `[STATUS SUBMISSION]
Server-name: Engineering Team
Check-in Type: STANDUP
Current Progress: Implemented user authentication API
Working On: Testing edge cases and error handling
Next Steps: Begin frontend integration
Blockers: Dependency issues with auth library
ETA: Friday afternoon

sending my personal updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: '✅ Status recorded! Your individual work update has been saved and will be included in the next team report.',
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
    [
      {
        name: 'team-lead',
        content: {
          text: `[WORK TRACKING]
Server-name: Product Development
Check-in Type: PROJECT_STATUS
Current Progress: Completed feature specification documents
Working On: Coordinating with design team on mockups
Next Steps: Schedule technical planning session
Blockers: Resource allocation pending approval
ETA: End of sprint

sending my personal updates`,
        },
      },
      {
        name: 'jimmy',
        content: {
          text: "✅ Your individual status has been logged. I've noted your blockers regarding resource allocation approval.",
          actions: ['recordTeamMemberUpdates'],
        },
      },
    ],
  ],
};

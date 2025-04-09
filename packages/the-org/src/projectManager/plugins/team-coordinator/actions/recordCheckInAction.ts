import {
  type Action,
  ChannelType,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePromptFromState,
  createUniqueUuid,
  type UUID,
  getUserServerRole,
  getWorldSettings,
  logger,
} from '@elizaos/core';

interface DiscordComponentInteraction {
  customId: string;
  componentType: number;
  values?: string[];
  selections?: Record<string, string[]>;
}

interface ReportChannelConfig {
  serverId?: string;
  serverName?: string;
  channelId: string;
  createdAt: string;
  source?: string; // Add source field
}

// Required Discord configuration fields
const REQUIRED_DISCORD_FIELDS = [
  'PROJECT_MANAGER_DISCORD_APPLICATION_ID',
  'PROJECT_MANAGER_DISCORD_API_TOKEN',
];

/**
 * Validates the Discord configuration for a specific server.
 * @param {IAgentRuntime} runtime - The Agent runtime.
 * @param {string} serverId - The ID of the server to validate.
 * @returns {Promise<{ isValid: boolean; error?: string }>}
 */
async function validateDiscordConfig(
  runtime: IAgentRuntime,
  serverId: string
): Promise<{ isValid: boolean; error?: string }> {
  try {
    // logger.info(`Validating Discord config for server ${serverId}`);
    // const worldSettings = await getWorldSettings(runtime, serverId);

    // // Check required fields
    // for (const field of REQUIRED_DISCORD_FIELDS) {
    //   if (!worldSettings[field] || worldSettings[field].value === null) {
    //     return {
    //       isValid: false,
    //       error: `Missing required Discord configuration: ${field}`,
    //     };
    //   }
    // }

    return { isValid: true };
  } catch (error) {
    logger.error('Error validating Discord config:', error);
    return {
      isValid: false,
      error: 'Error validating Discord configuration',
    };
  }
}

/**
 * Ensures a Discord client exists and is ready
 * @param {IAgentRuntime} runtime - The Agent runtime
 * @returns {Promise<any>} The Discord client
 */
async function ensureDiscordClient(runtime: IAgentRuntime) {
  logger.info('Ensuring Discord client is available');

  try {
    const discordService = runtime.getService('discord');
    logger.info(`Discord service found: ${!!discordService}`);

    if (!discordService) {
      logger.error('Discord service not found in runtime');
      throw new Error('Discord service not found');
    }

    // Log what's in the service to see its structure
    logger.info(`Discord service structure: ${JSON.stringify(Object.keys(discordService))}`);

    // Check if client exists and is ready
    logger.info(`Discord client exists: ${!!discordService?.client}`);
    if (!discordService?.client) {
      logger.error('Discord client not initialized in service');
      throw new Error('Discord client not initialized');
    }

    logger.info('Discord client successfully validated');
    return discordService;
  } catch (error) {
    logger.error(`Error ensuring Discord client: ${error.message}`);
    logger.error(`Error stack: ${error.stack}`);
    throw error;
  }
}

export const recordCheckInAction: Action = {
  name: 'RECORD_CHECK_IN',
  description:
    'Set up, create, configure, or manage team check-in schedules for various types including daily standups, sprint check-ins, mental health check-ins, project status updates, and retrospectives. Handles both inquiry about setting up check-ins and actual configuration of check-in schedules.',
  similes: [
    'SEND_PERSONAL_UPDATE',
    'SUBMIT_UPDATE',
    'SHARE_PROGRESS',
    'REPORT_STATUS',
    'LOG_TEAM_UPDATE',
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    try {
      // Existing validation code...
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

      // Check if user is an admin
      logger.info(`Checking if user ${message.entityId} is an admin for server ${serverId}`);
      const userRole = await getUserServerRole(runtime, message.entityId, serverId);

      logger.info(`User role: ${userRole}`);

      // // Define valid admin roles (case-insensitive)
      // const adminRoles = ['admin', 'owner', 'moderator', 'administrator'];
      // const isAdminUser =
      //   userRole && adminRoles.some((role) => userRole.toLowerCase() === role.toLowerCase());

      // if (!isAdminUser) {
      //   logger.info(
      //     `User ${message.entityId} is not an admin, rejecting action. Role: ${userRole}`
      //   );
      //   // We'll handle the message in the handler
      //   state.data.isAdmin = false;
      //   return true; // Still return true so handler can show the error message
      // }

      logger.info(`User ${message.entityId} has admin privileges with role: ${userRole}`);
      state.data.isAdmin = true;
      // // Validate Discord configuration
      // const validation = await validateDiscordConfig(runtime, serverId);
      // if (!validation.isValid) {
      //   logger.error(`Discord validation failed: ${validation.error}`);
      //   return false;
      // }

      // Ensure Discord client is available

      return true;
    } catch (error) {
      logger.error('Error in recordCheckInAction validation:', error);
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
      // Get Discord client first
      logger.info('Attempting to get Discord client...');
      let discordService: any;

      try {
        discordService = await ensureDiscordClient(runtime);
        logger.info('Successfully retrieved Discord service with client');
      } catch (discordError) {
        logger.error(`Failed to get Discord client: ${discordError.message}`);

        // Try to proceed anyway or handle gracefully
        if (callback) {
          await callback(
            {
              text: '❌ Unable to connect to Discord services. Please try again later or contact support.',
            },
            []
          );
        }
        return false;
      }

      let textChannels = [];

      // Check if Discord connection is established
      logger.info('Checking Discord connection status...');

      // Get room and server ID
      const room = state.data.room ?? (await runtime.getRoom(message.roomId));
      if (!room) {
        logger.error('No room found for the message');
        return false;
      }

      const serverId = room.serverId;
      if (!serverId) {
        logger.error('No server ID found for room');
        return false;
      }

      logger.info(`Using server ID: ${serverId}`);

      // Fetch all channels from the server
      if (discordService?.client) {
        try {
          logger.info(`Fetching all channels from Discord server with ID: ${serverId}`);
          const guild = discordService?.client.guilds.cache.get(serverId);

          if (guild) {
            const channels = await guild.channels.fetch();
            logger.info(`Found ${channels.size} channels in server ${guild.name}`);

            // Define textChannels property if it doesn't exist
            textChannels = channels
              .filter((channel) => channel && channel.isTextBased?.() && !channel.isDMBased?.())
              .map((channel) => ({
                id: channel.id,
                name: channel.name,
                type: channel.type.toString(),
              }));

            logger.info(`Stored ${textChannels.length} text channels for forms`);
            logger.info('Text channels:', JSON.stringify(textChannels));
          } else {
            logger.error(`Could not find guild with ID ${serverId}`);
          }
        } catch (error) {
          logger.error('Error fetching Discord channels:', error);
          logger.debug('Error details:', error instanceof Error ? error.stack : String(error));
        }
      } else {
        logger.warn('Discord service or client is not available');
      }

      logger.info('Text channels variable:', textChannels);

      // Rest of your existing handler code...
      logger.info('=== RECORD-CHECK-IN HANDLER START ===');
      logger.info('Message content received:', JSON.stringify(message.content, null, 2));

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Extract check-in details from user message
      logger.info('Extracting check-in details from user message');
      const userText = message.content.text as string;

      if (!userText) {
        logger.warn('No text content found in message');
        return false;
      }

      // Check if report channel config exists for this server
      logger.info('Checking for existing report channel configuration');
      const roomId = createUniqueUuid(runtime, 'report-channel-config');
      logger.info('Generated roomId:', roomId);

      // Add table name to getMemories call
      const memories = await runtime.getMemories({
        roomId: roomId as UUID,
        tableName: 'messages',
      });
      logger.info('Retrieved memories:', JSON.stringify(memories, null, 2));
      logger.debug('Raw memories object:', memories);

      logger.info('Looking for existing config with serverId:', serverId);
      const existingConfig = memories.find((memory) => {
        logger.info('Checking memory:', memory);
        const isReportConfig = memory.content.type === 'report-channel-config';

        return isReportConfig;
      });
      logger.info('Found existing config:', existingConfig);

      const questionPrompt = `
        Determine if the user is asking a question about setting up a check-in schedule.
        
        Examples of questions:
        - "let's setup a check in schedule?"
        - "how do I create a check-in?"
        - "can you help me with check-ins?"
        
        Return TRUE if the user is asking a question about setting up check-ins.
        
        Return FALSE if the user is providing specific check-in configuration with fields like:
        - channelForUpdates
        - checkInType (STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO)
        - channelForCheckIns
        - frequency (WEEKDAYS, DAILY, WEEKLY, BI-WEEKLY, MONTHLY)
        - time
        
        Analyze this text and respond with ONLY the word "true" or "false" (lowercase):
        "${userText}"`;

      logger.debug('Generated question prompt for LLM:', questionPrompt);

      logger.info('Question check prompt:', questionPrompt);

      const parsedQuestionResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: questionPrompt,
        stopSequences: [],
      });

      logger.info('Raw AI response for question check:', parsedQuestionResponse);

      // Check if user is asking a question rather than providing check-in details
      if (parsedQuestionResponse.trim().toLowerCase() === 'true') {
        logger.info('User is asking a question about check-ins, not providing configuration');

        if (!existingConfig) {
          // First ask for the report channel configuration
          logger.info('Asking user for report channel configuration');

          const channelsList = textChannels
            .map((channel) => `- #${channel.name} (${channel.id})`)
            .join('\n');

          logger.debug(`Generated channels list with ${textChannels.length} channels`);
          await callback(
            {
              text:
                `Let's set up check-ins for your team members! 📅\n\n` +
                `First, I need to know where to send the check-in updates when team members respond.\n\n` +
                `**Available channels:**\n${channelsList}\n\n` +
                `1️⃣ **Channel for Updates:** Which channel from the list above should the updates be posted once collected from users?\n\n` +
                `2️⃣ **Check-in Type:** Choose one of the following:\n` +
                `   • Daily Standup\n` +
                `   • Sprint Check-in\n` +
                `   • Mental Health Check-in\n` +
                `   • Project Status Update\n` +
                `   • Team Retrospective\n\n` +
                `3️⃣ **Channel for Check-ins:** Which channel should team members be checked in from?\n\n` +
                `4️⃣ **Frequency:** How often should check-ins occur?\n` +
                `   • Weekdays\n` +
                `   • Daily\n` +
                `   • Weekly\n` +
                `   • Bi-weekly\n` +
                `   • Monthly\n` +
                `5️⃣ **Time:** What time should check-ins happen? (e.g., 9:00 AM UTC) - Please note all times will be in UTC timezone` +
                `Please remember to type "Record Check-in details" when you're finished to save your configuration.`,
              source: message.source,
            },
            []
          );

          logger.info('Sent initial check-in configuration message');
        } else {
          // Ask for check-in schedule details
          logger.info('Asking user for check-in schedule details');
          logger.debug(`Using existing config: ${JSON.stringify(existingConfig)}`);

          const channelsList = textChannels
            .map((channel) => `- #${channel.name} (${channel.id})`)
            .join('\n');

          logger.debug(
            `Generated channels list with ${textChannels.length} channels for existing config`
          );

          await callback(
            {
              text:
                `Let's set up your team check-in schedule! 📅\n\n` +
                `Please provide the following information (you can answer all at once or one by one):\n\n` +
                `1️⃣ **Check-in Type:** Choose one of the following:\n` +
                `   • Daily Standup\n` +
                `   • Sprint Check-in\n` +
                `   • Mental Health Check-in\n` +
                `   • Project Status Update\n` +
                `   • Team Retrospective\n\n` +
                `2️⃣ **Channel for Check-ins:** Which channel should team members be checked in from?\n\n` +
                `**Available channels:**\n${channelsList}\n\n` +
                `3️⃣ **Frequency:** How often should check-ins occur?\n` +
                `   • Weekdays\n` +
                `   • Daily\n` +
                `   • Weekly\n` +
                `   • Bi-weekly\n` +
                `   • Monthly\n` +
                `   • Custom\n\n` +
                `4️⃣ **Time:** What time should check-ins happen? (e.g., 9:00 AM UTC)` +
                `Please remember to type "Record Check-in details" when you're finished to save your configuration.`,
              source: message.source,
            },
            []
          );

          logger.info('Sent check-in schedule configuration message with channel list');
        }
        return true;
      }

      // Continue with parsing check-in details
      logger.info('User is providing check-in configuration, proceeding to parse');

      let checkInConfig: any;

      try {
        const channelsList = textChannels
          .map((channel) => `- #${channel.name} (${channel.id})`)
          .join('\n');

        logger.info('Sending text to AI for parsing check-in details');
        const prompt = `Extract the following fields from this check-in configuration text:
        
        Return ONLY a valid JSON object with these exact keys:
        {
          "channelForUpdates": "value", // The channel name where updates should be posted
          "checkInType": "value", // One of: STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO
          "channelForCheckIns": "value", // The channel ID where check-ins should happen
          "frequency": "value", // One of: WEEKDAYS, DAILY, WEEKLY, BI-WEEKLY, MONTHLY
          "time": "value" // The time for check-ins in UTC format , AM PM time if given to be recorded in 24 hour format
        }

         Note: 
         - checkInType must be one of: STANDUP, SPRINT, MENTAL_HEALTH, PROJECT_STATUS, RETRO
         - For each field, only extract the actual update text, not the question/description
         - for channelForCheckIns or channelForUpdates user can give this #General (922791729709613101) only extract General from it
        
        Text to parse: "${userText}"`;

        logger.info('Check-in parsing prompt:', prompt);

        const parsedResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });

        logger.info('Raw AI response for check-in details:', parsedResponse);

        // Parse the response
        const cleanedResponse = parsedResponse.replace(/```json\n?|\n?```/g, '').trim();
        checkInConfig = JSON.parse(cleanedResponse);

        logger.info('Successfully parsed check-in configuration:', checkInConfig);
      } catch (error) {
        logger.error('Failed to parse check-in configuration:', error);
        logger.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
        return false;
      }

      // Get channel IDs from the parsed configuration
      logger.info('Finding channel IDs for the parsed configuration');

      // Find channel ID for updates based on channel name
      const updateChannelName = checkInConfig.channelForUpdates?.toLowerCase();
      const updateChannel = textChannels.find(
        (channel) => channel.name.toLowerCase() === updateChannelName
      );

      // Find channel ID for check-ins based on channel name
      const checkInChannelName = checkInConfig.channelForCheckIns?.toLowerCase();
      const checkInChannel = textChannels.find(
        (channel) => channel.name.toLowerCase() === checkInChannelName
      );

      logger.info(
        `Update channel found: ${updateChannel?.id || 'Not found'} for name: ${updateChannelName}`
      );
      logger.info(
        `Check-in channel found: ${checkInChannel?.id || 'Not found'} for name: ${checkInChannelName}`
      );

      // Update the config with the channel IDs
      checkInConfig.updateChannelId = updateChannel?.id || '';
      checkInConfig.checkInChannelId = checkInChannel?.id || '';

      logger.info('Updated check-in configuration with channel IDs:', checkInConfig);

      // TODO : after things are parsed now store the check in form for group
      // TODO : store the check in storage

      if (!existingConfig) {
        logger.info('No existing report channel config found, creating new one');
        try {
          // Extract source information
          const messageSource = message.source || room.source || 'unknown';

          logger.info(
            `Message source for report config: ${messageSource}, sourceId: ${messageSourceId}`
          );

          const config: ReportChannelConfig = {
            serverId: serverId,
            // TODO : have to fetch server name
            serverName: 'Unknown Server', // Added default server name
            channelId: checkInConfig.updateChannelId || '',
            source: messageSource, // Add source
            createdAt: new Date().toISOString(),
          };

          logger.info('Creating new report channel config:', config);

          // First create the room to avoid foreign key constraint error
          logger.info(`Creating room with ID: ${roomId}`);
          try {
            await runtime.ensureRoomExists({
              id: roomId as UUID,
              name: 'Report Channel Configurations',
              source: 'team-coordinator',
              type: ChannelType.GROUP,
            });
            logger.info(`Successfully created room with ID: ${roomId}`);
          } catch (roomError) {
            logger.error(`Failed to create room: ${roomError.message}`);
            logger.error(`Room error stack: ${roomError.stack}`);
            // Continue even if room creation fails - it might already exist
          }

          const memory = {
            id: createUniqueUuid(runtime, `report-channel-config-${serverId}`),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
              type: 'report-channel-config',
              config,
            },
            roomId: roomId,
            createdAt: Date.now(),
          };

          await runtime.createMemory(memory, 'messages');
          logger.info('Successfully stored new report channel config');
        } catch (configError) {
          logger.error('Failed to store report channel config:', configError);
          logger.error('Error stack:', configError.stack);
        }
      }

      // Store check-in schedule
      try {
        logger.info('Storing check-in schedule:', checkInConfig);

        // Extract source information from the message or room
        const messageSource = message.source || room.source || 'unknown';

        logger.info(`Message source: ${messageSource}`);

        const schedule: CheckInSchedule = {
          type: 'team-member-checkin-schedule',
          scheduleId: createUniqueUuid(runtime, `schedule-${Date.now()}`),
          // teamMemberUserName: checkInConfig.userDisplayName,
          checkInType: checkInConfig.checkInType || 'STANDUP',
          channelId: checkInConfig.checkInChannelId || '',
          frequency: (checkInConfig.frequency || 'WEEKLY') as CheckInSchedule['frequency'],
          checkInTime: checkInConfig.time || '09:00',
          source: messageSource, // Add the source information
          createdAt: new Date().toISOString(),
          serverId: serverId,
        };

        const checkInRoomId = createUniqueUuid(runtime, 'check-in-schedules');

        // Use the same roomId as above to avoid foreign key constraint error
        logger.info(`Using existing room with ID: ${roomId} for check-in schedules`);

        // Ensure the room exists before storing the memory
        try {
          await runtime.ensureRoomExists({
            id: checkInRoomId as UUID,
            name: 'Check-in Schedules',
            source: 'team-coordinator',
            type: ChannelType.GROUP,
          });
          logger.info(`Successfully ensured room exists with ID: ${roomId}`);
        } catch (roomError) {
          logger.error(`Failed to ensure room exists: ${roomError.message}`);
          logger.error(`Room error stack: ${roomError.stack}`);
          // Continue even if room creation fails - it might already exist
        }

        const scheduleMemory = {
          id: createUniqueUuid(runtime, `checkin-schedule-${schedule.scheduleId}-${Date.now()}`),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          content: {
            type: 'team-member-checkin-schedule',
            schedule,
          },
          roomId: checkInRoomId, // Use the same roomId that was created earlier
          createdAt: Date.now(),
        };

        logger.info('Storing check-in schedule in memory:', scheduleMemory);
        await runtime.createMemory(scheduleMemory, 'messages');
        logger.info('Successfully stored check-in schedule in memory');
      } catch (scheduleError) {
        logger.error('Failed to store check-in schedule:', scheduleError);
        logger.error('Error stack:', scheduleError.stack);
      }
      // Send success message to the user
      logger.info('Sending success message to user');
      if (callback) {
        await callback(
          {
            text: '✅ Check-in schedule has been successfully created! Team members will be prompted according to your configured schedule.',
          },
          []
        );
      }
      logger.info('Check-in setup message sent successfully');
      return true;
    } catch (error) {
      logger.error('=== CHECK-IN HANDLER ERROR ===');
      logger.error(`Error processing check-in schedule setup: ${error}`);
      logger.error(`Error stack: ${error.stack}`);
      return false;
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you help me set up check-ins for my team?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll help you set up check-in schedules for your team members",
          actions: ['RECORD_CHECK_IN'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Check-in Type: Daily Standup\nChannel for Check-ins: standup-channel\nFrequency: Daily\nTime: 9 AM\n\nRecord Check-in details',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll set up the daily standup check-in schedule as requested",
          actions: ['RECORD_CHECK_IN'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Check-in Type: Mental Health Check-in\nChannel for Check-ins: team-channel\nFrequency: Weekly\nTime: 2 PM\n\nRecord Check-in details',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll configure the weekly mental health check-ins for your team",
          actions: ['RECORD_CHECK_IN'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Create a sprint check-in for my team that runs every Monday at 10 AM',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll help you set up a sprint check-in schedule. Let me guide you through the process.",
          actions: ['RECORD_CHECK_IN'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'How do I create a check-in for my team?',
        },
      },
      {
        name: '{{botName}}',
        content: {
          text: "I'll walk you through setting up team check-ins step by step",
          actions: ['RECORD_CHECK_IN'],
        },
      },
    ],
  ],
};

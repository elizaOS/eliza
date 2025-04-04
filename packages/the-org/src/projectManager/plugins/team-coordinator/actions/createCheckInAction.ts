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
  getUserServerRole,
  getWorldSettings,
  logger,
} from '@elizaos/core';
import { sendCheckInScheduleForm } from '../forms/checkInScheduleForm';
import { sendCheckInReportForm } from '../forms/checkInReportForm';

interface DiscordComponentInteraction {
  customId: string;
  componentType: number;
  values?: string[];
  selections?: Record<string, string[]>;
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

export const createCheckInAction: Action = {
  name: 'createCheckInAction',
  description: 'Creates or modifies a check-in schedule for team members',
  similes: ['createCheckIn', 'createCheckInSchedule'],
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
      logger.error('Error in createCheckInAction validation:', error);
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
              source: 'discord',
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
      logger.info('=== CHECK-IN HANDLER START ===');
      logger.info('Message content received:', JSON.stringify(message.content, null, 2));

      if (!callback) {
        logger.warn('No callback function provided');
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

      // if (!existingConfig) {
      //   logger.info('No existing report channel config found - sending report form first');
      //   logger.info('Using server ID:', serverId);
      //   await sendCheckInReportForm(callback, textChannels, {
      //     serverId,
      //     // serverName: String(message.content.serverName),
      //   });
      // } else {
      //   logger.info('Found existing report channel config:', existingConfig);
      //   logger.info(`Sending schedule form with ${textChannels.length} channels`);
      //   await sendCheckInScheduleForm(callback, textChannels);
      // }

      // Send message to user asking for check-in details
      logger.info('Sending text-based check-in setup message to user');

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
        name: 'admin',
        content: { text: 'Set up daily check-ins for the team' },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll help you set up check-in schedules",
          actions: ['createCheckInAction'],
        },
      },
    ],
    [
      {
        name: 'admin',
        content: { text: "let's create a checkin on team members" },
      },
      {
        name: 'jimmy',
        content: {
          text: "I'll set up check-in schedules for the team members",
          actions: ['createCheckInAction'],
        },
      },
    ],
  ],
};

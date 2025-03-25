import {
  type IAgentRuntime,
  logger,
  type Memory,
  createUniqueUuid,
  Service,
  ChannelType,
  type UUID,
} from '@elizaos/core';
import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  SelectMenuInteraction,
  User,
} from 'discord.js';

interface CheckInSchedule {
  type: 'team-member-checkin-schedule';
  scheduleId: string;
  teamMemberId: string;
  checkInType: string;
  channelId: string;
  frequency: 'WEEKDAYS' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
  checkInTime: string; // Time in "HH:mm" format
  createdAt: string;
}

type BaseInteraction = ButtonInteraction | StringSelectMenuInteraction | SelectMenuInteraction;

// Define our custom interaction type
interface ExtendedInteraction {
  customId: string;
  user?: User;
  member?: { user?: { id: string } };
  selections?: {
    checkin_frequency?: string[];
    checkin_time?: string[];
    timezone?: string[];
    checkin_days?: string[];
    checkin_type?: string[];
    checkin_channel?: string[];
  };
}

export class CheckInService extends Service {
  private formSelections: Map<string, Record<string, string[]>> = new Map();
  static serviceType = 'CHECKIN_SERVICE';
  capabilityDescription = 'Manages team member check-in schedules';

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
  }

  async start(): Promise<void> {
    logger.info('=== INITIALIZING CHECKIN SERVICE ===');
    await this.initialize();

    // Call the notify function after initialization is complete
    await this.notifyAllUsersInChannel(
      'Welcome to the check-in service! You will receive regular check-in prompts based on your schedule.',
      'new' // Pass the channel name as a parameter
    );

    logger.info('CheckIn Service started successfully');
  }

  async stop(): Promise<void> {
    logger.info('Stopping CheckIn Service');
    // Cleanup if needed
  }

  static async start(runtime: IAgentRuntime): Promise<CheckInService> {
    const service = new CheckInService(runtime);
    await service.start();
    return service;
  }

  private async initialize() {
    // Listen for Discord interactions
    this.runtime.registerEvent('DISCORD_INTERACTION', async (event) => {
      try {
        logger.info('=== DISCORD INTERACTION RECEIVED ===');
        logger.info('Raw event:', event);

        if (!event) {
          logger.error('Event is undefined or null');
          return;
        }

        const { interaction } = event;
        if (!interaction) {
          logger.error('No interaction in event:', event);
          return;
        }

        logger.info('Basic interaction info:', {
          exists: !!interaction,
          customId: interaction?.customId || 'NO_CUSTOM_ID',
          type: interaction?.type || 'NO_TYPE',
          hasUser: !!interaction?.user,
          hasSelections: !!interaction?.selections,
          allFields: Object.keys(interaction || {}),
        });

        // Check if this is a button interaction
        if (interaction.isButton?.()) {
          logger.info('Button interaction detected');
        }

        // Check if this is a modal submit
        if (interaction.isModalSubmit?.()) {
          logger.info('Modal submit detected');
        }

        if (interaction.customId === 'submit_checkin_schedule') {
          logger.info('Found matching customId: submit_checkin_schedule');
          await this.handleCheckInSubmission(interaction as ExtendedInteraction);
        } else {
          logger.info('CustomId did not match. Received:', interaction.customId);
        }
      } catch (error) {
        logger.error('Error in DISCORD_INTERACTION event handler:', error);
        logger.error('Error stack:', error.stack);
      }
    });

    logger.info('CheckIn Service initialized and listening for events');
  }

  /**
   * Sends a direct message to all users in a specific Discord channel
   * @param message The message to send to all users
   * @param channelName The name of the Discord channel to fetch users from
   */
  async notifyAllUsersInChannel(message: string, channelName = 'new'): Promise<void> {
    try {
      logger.info(`=== STARTING NOTIFICATION TO ALL USERS IN "${channelName}" CHANNEL ===`);
      logger.info(`Target channel name: ${channelName}`);

      // Emit an event to fetch users from a Discord channel
      logger.info(`Requesting users from Discord channel: ${channelName}`);

      try {
        // Define a type for the expected response
        interface ChannelMembersResponse {
          users?: Array<{
            id: string;
            username?: string;
          }>;
          success?: boolean;
          error?: string;
        }

        // Get users in the specified channel by emitting a custom event
        // First emit the event (which returns void)
        await this.runtime.emitEvent('DISCORD_FETCH_CHANNEL_MEMBERS', {
          channelName,
        });

        // We have to use a different approach since emitEvent doesn't return data
        // Ideally, we'd register a callback or get data another way, but for now:

        // Mock data for demonstration - in real implementation, you would get this data
        // from another source like a service call or database
        const mockFetchResult: ChannelMembersResponse = {
          users: [
            // Add test users for demonstration - replace with actual implementation
            // { id: '123456789012345678', username: 'TestUser1' },
          ],
          success: true,
        };

        logger.info('Channel members data:', mockFetchResult);

        // Extract user IDs from the fetch result
        const channelUsers = mockFetchResult?.users || [];
        logger.info(`Found ${channelUsers.length} users in channel "${channelName}"`);

        if (channelUsers.length === 0) {
          logger.warn(`No users found in channel "${channelName}" or channel not found`);
          return;
        }

        // Send DM to each user in the channel
        for (const user of channelUsers) {
          const userId = user.id;

          // Skip sending messages to ourself (the agent)
          if (userId === this.runtime.agentId) {
            logger.info(`Skipping agent user: ${userId}`);
            continue;
          }

          logger.info(`Sending DM to user: ${userId} (${user.username || 'unknown'})`);

          try {
            await this.sendDirectMessage(userId, message);
            logger.info(`Successfully sent DM to user: ${userId}`);
          } catch (dmError) {
            logger.error(`Failed to send DM to user ${userId}:`, dmError);
          }
        }

        logger.info(`=== COMPLETED NOTIFICATION TO USERS IN "${channelName}" CHANNEL ===`);
      } catch (channelError) {
        logger.error(`Error fetching users from channel "${channelName}":`, channelError);

        // Fallback to hardcoded users if channel fetch fails
        logger.info('Falling back to hardcoded user list');

        // Array of user IDs that should receive notifications
        const fallbackUserIds = [
          // Add your fallback user IDs here - uncomment and add real IDs as needed
          // "123456789012345678", // Example Discord user ID
        ];

        logger.info(`Will notify ${fallbackUserIds.length} fallback users`);

        if (fallbackUserIds.length === 0) {
          logger.warn('No fallback users specified, no messages will be sent');
          return;
        }

        // Send DM to each fallback user
        for (const userId of fallbackUserIds) {
          // Skip sending messages to ourself (the agent)
          if (userId === this.runtime.agentId) {
            logger.info(`Skipping agent user: ${userId}`);
            continue;
          }

          logger.info(`Sending DM to fallback user: ${userId}`);

          try {
            await this.sendDirectMessage(userId, message);
            logger.info(`Successfully sent DM to fallback user: ${userId}`);
          } catch (dmError) {
            logger.error(`Failed to send DM to fallback user ${userId}:`, dmError);
          }
        }

        logger.info('=== COMPLETED NOTIFICATION TO FALLBACK USERS ===');
      }
    } catch (error) {
      logger.error('Error in notifyAllUsersInChannel:', error);
      logger.error('Error stack:', error.stack);
    }
  }

  private async sendDirectMessage(userId: string, content: string) {
    try {
      // Create a DM room for this user if it doesn't exist
      const dmRoomId = createUniqueUuid(this.runtime, `dm-${userId}`);
      await this.runtime.ensureConnection({
        entityId: userId as UUID,
        roomId: dmRoomId as UUID,
        type: ChannelType.DM,
        source: 'team-coordinator',
      });

      // Create a memory in the DM room
      await this.runtime.createMemory(
        {
          id: createUniqueUuid(this.runtime, `msg-${Date.now()}`),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          content: { text: content },
          roomId: dmRoomId as UUID,
          createdAt: Date.now(),
        },
        'messages'
      );
    } catch (error) {
      logger.error('Failed to send direct message:', error);
    }
  }

  private async handleCheckInSubmission(interaction: ExtendedInteraction) {
    try {
      logger.info('=== HANDLING CHECKIN SUBMISSION ===');

      const selections = interaction.selections;
      const userId = interaction.user?.id || interaction.member?.user?.id;

      logger.info('Processing submission from user:', userId);
      logger.info('Form selections:', selections);

      if (!selections) {
        logger.warn('No form data found in submission');
        await this.runtime.emitEvent('DISCORD_RESPONSE', {
          type: 'REPLY',
          content: 'No form data received. Please try again.',
          ephemeral: true,
          interaction,
        });
        return;
      }

      // Create check-in schedule
      const schedule: CheckInSchedule = {
        type: 'team-member-checkin-schedule',
        scheduleId: createUniqueUuid(this.runtime, `schedule-${Date.now()}`),
        teamMemberId: userId || 'anonymous',
        checkInType: selections.checkin_type?.[0] || 'STANDUP',
        channelId: selections.checkin_channel?.[0] || '',
        frequency: (selections.checkin_frequency?.[0] || 'WEEKLY') as CheckInSchedule['frequency'],
        checkInTime: selections.checkin_time?.[0] || '09:00',
        createdAt: new Date().toISOString(),
      };

      // Store the schedule
      const roomId = createUniqueUuid(this.runtime, 'check-in-schedules');
      await this.storeCheckInSchedule(roomId, schedule);

      logger.info('Successfully stored check-in schedule:', schedule);

      // Send confirmation message
      await this.runtime.emitEvent('DISCORD_RESPONSE', {
        type: 'REPLY',
        content: `✅ Check-in schedule created!\nType: ${schedule.checkInType}\nFrequency: ${schedule.frequency}\nTime: ${schedule.checkInTime}`,
        ephemeral: true,
        interaction,
      });
    } catch (error) {
      logger.error('Error in handleCheckInSubmission:', error);
      logger.error('Error stack:', error.stack);

      try {
        // Check if this is a duplicate key error
        if (error.code === '23505' && error.constraint === 'memories_pkey') {
          await this.runtime.emitEvent('DISCORD_RESPONSE', {
            type: 'REPLY',
            content:
              '⚠️ This check-in schedule has already been submitted. You can either:\n• Create a new check-in schedule with different settings\n• Update the existing schedule',
            ephemeral: true,
            interaction,
          });
        } else {
          await this.runtime.emitEvent('DISCORD_RESPONSE', {
            type: 'REPLY',
            content: 'Failed to save check-in schedule. Please try again.',
            ephemeral: true,
            interaction,
          });
        }
      } catch (replyError) {
        logger.error('Failed to send error message:', replyError);
      }
    }
  }

  private async storeCheckInSchedule(roomId: string, schedule: CheckInSchedule): Promise<void> {
    try {
      // First create the room if it doesn't exist
      await this.runtime.ensureRoomExists({
        id: roomId as UUID,
        name: 'Check-in Schedules',
        source: 'team-coordinator',
        type: ChannelType.GROUP,
      });

      const timestamp = Date.now();
      const memory = {
        id: createUniqueUuid(this.runtime, `checkin-schedule-${schedule.scheduleId}-${timestamp}`),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          type: 'team-member-checkin-schedule',
          schedule,
        },
        roomId: roomId as UUID,
        createdAt: timestamp,
      };

      logger.info('Storing check-in schedule in memory:', memory);
      await this.runtime.createMemory(memory, 'messages');
      logger.info('Successfully stored check-in schedule in memory');
    } catch (error) {
      logger.error('Failed to store check-in schedule:', error);
      throw error;
    }
  }
}

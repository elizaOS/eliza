import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
  createUniqueUuid,
  logger,
  ChannelType,
} from '@elizaos/core';
import { sendCheckInScheduleForm } from '../forms/checkInScheduleForm';
import type { DiscordChannelService } from '../services/DiscordChannelService';

interface CheckInFormData {
  teamMemberId: string;
  frequency: 'DAILY' | 'WEEKLY' | 'CUSTOM';
  timeOfDay: string;
  timezone: string;
  daysOfWeek?: string[];
  channelId?: string; // Added channel ID for check-ins
}

interface CheckInSchedule {
  type: 'team-member-checkin-schedule';
  scheduleId: UUID;
  teamMemberId: string;
  frequency: 'DAILY' | 'WEEKLY' | 'CUSTOM';
  timeOfDay: string; // HH:mm format
  timezone: string;
  daysOfWeek?: string[]; // For weekly or custom schedules
  channelId?: string; // Discord channel where check-ins will be posted
  isActive: boolean;
  createdBy: string; // Admin ID
  createdAt: string;
  lastModified: string;
}

/**
 * Tracks form state between interactions
 */
interface FormState {
  frequency?: 'DAILY' | 'WEEKLY' | 'CUSTOM';
  timeOfDay?: string;
  timezone?: string;
  daysOfWeek?: string[];
  teamMemberId?: string;
  channelId?: string; // Added channel ID to form state
}

interface DiscordInteraction {
  customId: string;
  type: number; // 2 for button, 3 for select menu
  values?: string[]; // Only present for select menu
}

interface DiscordComponentInteraction {
  customId: string;
  componentType: number;
  values?: string[];
  selections?: Record<string, string[]>;
}

interface RuntimeEvents {
  'discord:interaction': (
    interaction: DiscordComponentInteraction,
    callback?: HandlerCallback
  ) => Promise<void>;
}

interface ExtendedRuntime extends IAgentRuntime {
  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]): void;
  processMemory(memory: Memory): Promise<void>;
}

/**
 * Stores a check-in schedule in the database
 */
async function storeCheckInSchedule(
  runtime: IAgentRuntime,
  roomId: UUID,
  schedule: CheckInSchedule
): Promise<void> {
  logger.info(`Storing check-in schedule for team member ${schedule.teamMemberId}`);

  const scheduleContent: Content = {
    type: 'team-member-checkin-schedule',
    schedule,
  };

  try {
    await runtime.createMemory(
      {
        id: createUniqueUuid(runtime, `checkin-schedule-${schedule.scheduleId}`),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: scheduleContent,
        roomId,
        createdAt: Date.now(),
      },
      'messages'
    );
    logger.info(`Successfully stored check-in schedule ${schedule.scheduleId}`);
  } catch (error) {
    logger.error(`Error storing check-in schedule: ${error}`);
    throw error;
  }
}

export const checkInTeamMember: Action = {
  name: 'checkInTeamMember',
  description: 'Creates or modifies a check-in schedule for team members',
  similes: ['scheduleCheckIn', 'createCheckInSchedule', 'setCheckInTime'],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
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
      logger.info('=== CHECK-IN HANDLER START ===');
      logger.info('Message content received:', JSON.stringify(message.content, null, 2));

      if (!callback) {
        logger.warn('No callback function provided');
        return false;
      }

      // Handle Discord component interaction
      const discordInteraction = message.content?.discordInteraction as DiscordComponentInteraction;
      if (discordInteraction) {
        logger.info('Processing Discord component interaction:', {
          customId: discordInteraction.customId,
          componentType: discordInteraction.componentType,
          values: discordInteraction.values,
        });

        // If this is a form submission with complete data
        if (discordInteraction.customId === 'submit_checkin_schedule') {
          logger.info('Processing complete form submission');

          // Get the selections from the interaction
          const selections = discordInteraction.selections;
          if (!selections) {
            logger.warn('No form selections found');
            await callback(
              {
                text: '❌ No form data found. Please fill the form again.',
                source: 'discord',
              },
              []
            );
            return true;
          }

          logger.info('Form selections:', selections);

          const schedule: CheckInSchedule = {
            type: 'team-member-checkin-schedule',
            scheduleId: createUniqueUuid(runtime, `schedule-${message.entityId}`),
            teamMemberId: message.entityId,
            frequency: selections.checkin_frequency?.[0] as 'DAILY' | 'WEEKLY' | 'CUSTOM',
            timeOfDay: selections.checkin_time?.[0],
            timezone: selections.timezone?.[0],
            daysOfWeek: selections.checkin_days,
            channelId: selections.checkin_channel?.[0], // Store the selected channel ID
            isActive: true,
            createdBy: message.entityId,
            createdAt: new Date().toISOString(),
            lastModified: new Date().toISOString(),
          };

          logger.info('Created check-in schedule with channel:', schedule.channelId);

          // Validate schedule data
          if (!schedule.frequency || !schedule.timeOfDay || !schedule.timezone) {
            logger.warn('Missing required fields in form submission');
            await callback(
              {
                text: '❌ Missing required fields in form submission. Please fill all required fields.',
                source: 'discord',
              },
              []
            );
            return true;
          }

          // For weekly/custom schedules, days are required
          if (
            (schedule.frequency === 'WEEKLY' || schedule.frequency === 'CUSTOM') &&
            (!schedule.daysOfWeek || schedule.daysOfWeek.length === 0)
          ) {
            logger.warn('Days required for weekly/custom schedule but not provided');
            await callback(
              {
                text: '❌ Please select the days for check-in',
                source: 'discord',
              },
              []
            );
            return true;
          }

          try {
            // Store the schedule
            const checkInSchedulesRoomId = createUniqueUuid(runtime, 'check-in-schedules');
            await storeCheckInSchedule(runtime, checkInSchedulesRoomId, schedule);
            logger.info('Successfully stored check-in schedule');

            // Send confirmation
            await callback(
              {
                text: `✅ Successfully created check-in schedule.\nFrequency: ${schedule.frequency}\nTime: ${schedule.timeOfDay} ${schedule.timezone}${
                  schedule.daysOfWeek ? `\nDays: ${schedule.daysOfWeek.join(', ')}` : ''
                }${schedule.channelId ? `\nChannel: <#${schedule.channelId}>` : ''}`,
                source: 'discord',
              },
              []
            );
            return true;
          } catch (error) {
            logger.error('Error saving check-in schedule:', error);
            await callback(
              {
                text: '❌ Error saving check-in schedule. Please try again.',
                source: 'discord',
              },
              []
            );
            return false;
          }
        } else if (discordInteraction.customId === 'cancel_checkin_schedule') {
          logger.info('Cancelling check-in schedule creation');
          await callback(
            {
              text: '❌ Check-in schedule creation cancelled.',
              source: 'discord',
            },
            []
          );
          return true;
        }
      }

      // If no interaction, show the initial form
      logger.info('No interaction found - sending initial form...');

      // Add a small delay to ensure Discord services are initialized
      logger.info('Waiting a moment for Discord services to initialize...');
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Get available Discord channels from DiscordChannelService
      let channels = [];
      try {
        // Get the DiscordChannelService
        const discordChannelService = runtime.getService(
          'discord-channel-service'
        ) as DiscordChannelService;

        if (discordChannelService) {
          logger.info('Found DiscordChannelService, getting channels');
          channels = discordChannelService.getTextChannels();
          logger.debug(`Retrieved ${channels.length} channels from DiscordChannelService`);
        }

        // Also try to get direct access to Discord client as a backup approach
        if (channels.length === 0) {
          logger.info(
            'No channels found via DiscordChannelService, trying direct Discord service access'
          );
          try {
            const discordService = runtime.getService('discord');
            // Use type interface to avoid using 'any'
            interface DiscordClient {
              guilds?: {
                cache?: {
                  first?: () => {
                    name?: string;
                    channels?: {
                      cache?: Map<
                        string,
                        {
                          id: string;
                          name: string;
                          type: number;
                        }
                      >;
                    };
                  };
                  size?: number;
                };
              };
            }

            if (discordService && 'client' in discordService && discordService.client) {
              const client = discordService.client as DiscordClient;

              // Log whether guilds are available - use optional chaining
              logger.debug('Discord client found, checking for guilds...');
              if (client.guilds?.cache?.size && client.guilds.cache.size > 0) {
                const guild = client.guilds.cache.first?.();
                if (guild?.name) {
                  logger.info(`Found guild: ${guild.name}`);

                  // Try to get text channels from the first guild - use optional chaining
                  if (guild.channels?.cache) {
                    let textChannelCount = 0;

                    // Use for...of instead of forEach
                    for (const [_, channel] of guild.channels.cache) {
                      if (channel && channel.type === 0) {
                        // 0 is TEXT channel in discord.js v14
                        channels.push({
                          id: channel.id,
                          name: channel.name,
                          type: 'GROUP',
                        });
                        textChannelCount++;
                      }
                    }

                    logger.info(
                      `Found ${textChannelCount} text channels directly from Discord service`
                    );
                  }
                }
              } else {
                logger.warn('Discord client found but no guilds available');
              }
            }
          } catch (innerError) {
            logger.warn('Error accessing Discord service directly:', innerError);
          }
        }

        // Ensure we always have some default channels if none were found
        if (channels.length === 0) {
          logger.warn('No channels found from any source, using default channels');
          channels = [
            { id: 'general', name: 'general', type: 'GROUP' },
            { id: 'announcements', name: 'announcements', type: 'GROUP' },
            { id: 'check-ins', name: 'check-ins', type: 'GROUP' },
          ];
        }
      } catch (error) {
        logger.error('Error getting Discord channels:', error);
        logger.error('Error stack:', error.stack);

        // Provide default channels in case of error
        channels = [
          { id: 'general', name: 'general', type: 'GROUP' },
          { id: 'check-ins', name: 'check-ins', type: 'GROUP' },
        ];
      }

      // Send form with channels
      logger.info(`Sending form with ${channels.length} channels`);
      await sendCheckInScheduleForm(callback, channels);
      logger.info('Initial form sent successfully');
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
          actions: ['checkInTeamMember'],
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
          actions: ['checkInTeamMember'],
        },
      },
    ],
  ],
};

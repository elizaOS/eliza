import { IAgentRuntime, logger, EventType, Service, createUniqueUuid } from '@elizaos/core';
import type { Channel, Client, GuildChannel, TextChannel, VoiceChannel } from 'discord.js';
import { fetchCheckInSchedules } from '../actions/listCheckInSchedules';

export class TeamUpdateTrackerService extends Service {
  private client: Client | null = null;
  static serviceType = 'team-update-tracker-service';
  capabilityDescription =
    'Manages team member updates, check-ins, and coordinates communication through Discord channels';
  // Store available Discord channels
  private textChannels: Array<{ id: string; name: string; type: string }> = [];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  async start(): Promise<void> {
    logger.info('Starting Discord Channel Service');
    try {
      // Try to get the Discord service - it might not be available yet
      const discordService = this.runtime.getService('discord');
      if (discordService?.client) {
        logger.info('Discord service found, client available');
        this.client = discordService.client;

        // Set up interval to run every 30 minutes (30 * 60 * 1000 ms)
        setInterval(
          () => {
            logger.info('Running scheduled check-in service job (30-minute interval)');
            this.checkInServiceJob();
          },
          30 * 60 * 1000
        );

        logger.info('Check-in service job scheduler initialized');
      } else {
        logger.warn(
          'Discord service not found or client not available - will try to connect later'
        );
        this.setupDiscordRetry();
      }
    } catch (error) {
      logger.error('Error initializing Discord Channel Service:', error);
    }
  }

  private setupDiscordRetry() {
    // Check for Discord service every 30 seconds
    logger.info('Setting up retry for Discord service connection');
    const intervalId = setInterval(async () => {
      try {
        const discordService = this.runtime.getService('discord');
        if (discordService?.client) {
          logger.info('Discord service now available, connecting client');
          this.client = discordService.client;
          this.checkInServiceJob();

          clearInterval(intervalId);
        } else {
          logger.debug('Discord service still not available, will retry');
        }
      } catch (error) {
        logger.debug('Error checking for Discord service:', error);
      }
    }, 15000); // Check every 30 seconds
  }

  /**
   * Fetches all users in a Discord channel who have permission to view it
   * @param channelId - The Discord channel ID to fetch users from
   * @returns Array of users with access to the channel
   */
  public async fetchUsersInChannel(
    channelId: string
  ): Promise<Array<{ id: string; username: string; displayName: string; channelName: string }>> {
    logger.info(`Fetching users for channel ID: ${channelId}`);

    if (!this.client) {
      logger.error('Discord client is not available');
      return [];
    }

    try {
      const users: Array<{
        id: string;
        username: string;
        displayName: string;
        channelName: string;
      }> = [];

      // Fetch the channel from Discord
      const discordChannel = await this.client.channels.fetch(channelId);

      if (!discordChannel) {
        logger.warn(`Channel with ID ${channelId} not found`);
        return [];
      }

      logger.info(`Successfully fetched channel: ${discordChannel.id}`);

      // Check if it's a text channel in a guild
      if (
        discordChannel.isTextBased() &&
        !discordChannel.isDMBased() &&
        'guild' in discordChannel &&
        discordChannel.guild
      ) {
        const channelName = 'name' in discordChannel ? discordChannel.name : 'unknown-channel';
        logger.info(`Processing guild text channel: ${channelName}`);

        // Get all members who can view the channel
        const members = discordChannel.guild.members.cache;

        for (const [memberId, member] of members.entries()) {
          if (discordChannel.permissionsFor(member)?.has('ViewChannel')) {
            const user = {
              id: member.id,
              username: member.user.username,
              displayName: member.displayName,
              channelName: channelName,
            };

            users.push(user);
            logger.debug(`Added user to channel list: ${user.displayName} (${user.id})`);
          }
        }

        logger.info(
          `Found ${users.length} users with access to channel ${channelName} (${channelId})`
        );
      } else {
        logger.warn(`Channel ${channelId} is not a guild text channel`);
      }

      return users;
    } catch (error) {
      logger.error(`Error fetching users for channel ${channelId}:`, error);
      logger.error('Error stack:', error.stack);
      return [];
    }
  }

  /**
   * Sends a direct message to all users in the provided list
   * @param users Array of user objects containing id, username, displayName, and channelName
   * @param message The message content to send to each user
   * @returns Promise resolving to an array of user IDs that were successfully messaged
   */
  public async messageAllUsers(
    users: Array<{ id: string; username: string; displayName: string; channelName: string }>,
    message?: string
  ): Promise<string[]> {
    logger.info(`Attempting to message ${users.length} users`);
    const successfullyMessaged: string[] = [];

    if (!this.client) {
      logger.error('Discord client not available, cannot send messages');
      return successfullyMessaged;
    }

    for (const user of users) {
      try {
        logger.info(`Attempting to fetch Discord user: ${user.displayName} (${user.id})`);
        const discordUser = await this.client.users.fetch(user.id);

        if (discordUser && !discordUser.bot) {
          logger.info(`Sending message to non-bot user ${user.displayName} (${user.id})`);
          await discordUser.send(
            `Hi ${user.displayName}! Please share your latest updates for the ${user.channelName} channel.\n\n` +
              `Please use the following format for your update:\n` +
              `**Current Progress**: What you've accomplished recently\n` +
              `**Working On**: What you're currently focused on\n` +
              `**Next Steps**: What you plan to work on next\n` +
              `**Blockers**: Any issues preventing progress\n` +
              `**ETA**: Expected completion time for current task\n\n` +
              `Important: End your message with "sending my updates" so it can be properly tracked.`
          );
          logger.info(
            `Successfully sent update request to user ${user.displayName} (${user.id}) for channel ${user.channelName}`
          );
          successfullyMessaged.push(user.id);
        } else if (discordUser?.bot) {
          logger.info(`Skipping bot user ${user.displayName} (${user.id})`);
        } else {
          logger.warn(`Could not find Discord user with ID ${user.id}`);
        }
      } catch (error) {
        logger.error(`Failed to send DM to user ${user.displayName} (${user.id}):`, error);
        logger.error('Error stack:', error.stack);
      }
    }

    logger.info(`Successfully messaged ${successfullyMessaged.length}/${users.length} users`);
    return successfullyMessaged;
  }

  private async checkInServiceJob(): Promise<void> {
    logger.info('Running check-in service job');
    try {
      const discordService: any = this.runtime.getService('discord');
      if (discordService?.client) {
        logger.info('Discord service now available, connecting client');
        this.client = discordService.client;
      }
      // Dummy function for check-in service
      if (this.client) {
        logger.info('Discord client is available for check-in service');

        // we have following todos now
        // TODO: make this run every 30 mins cool

        // Fetch all check-in schedules
        logger.info('Fetching all check-in schedules...');
        try {
          const checkInSchedules = await fetchCheckInSchedules(this.runtime);
          logger.info(`Successfully fetched ${checkInSchedules.length} check-in schedules`);

          // Get current time in UTC
          const now = new Date();
          const currentHour = now.getUTCHours();
          const currentMinute = now.getUTCMinutes();
          const currentDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
          logger.info(`Current UTC time: ${currentHour}:${currentMinute}, day: ${currentDay}`);

          // Filter schedules that match the current time and haven't been updated in the last day
          const matchingSchedules = checkInSchedules.filter((schedule) => {
            // Check if the schedule has a lastUpdated date and if it's at least one day old
            const lastUpdated = schedule.lastUpdated ? new Date(schedule.lastUpdated) : null;
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            const shouldRunBasedOnLastUpdate = !lastUpdated || lastUpdated <= oneDayAgo;

            logger.debug(
              `Schedule ${schedule.scheduleId} last updated: ${lastUpdated ? lastUpdated.toISOString() : 'never'}, should run: ${shouldRunBasedOnLastUpdate}`
            );

            if (!shouldRunBasedOnLastUpdate) {
              logger.info(
                `Skipping schedule ${schedule.scheduleId} as it was updated less than a day ago`
              );
              return false;
            }

            // Parse the checkInTime (format: "HH:MM")
            const [scheduleHour, scheduleMinute] = schedule.checkInTime.split(':').map(Number);
            logger.debug(
              `Schedule time: ${scheduleHour}:${scheduleMinute} for schedule ID: ${schedule.scheduleId}`
            );

            // Check if current time matches schedule time (with 30 minute tolerance)
            const scheduleTimeInMinutes = scheduleHour * 60 + scheduleMinute;
            const currentTimeInMinutes = currentHour * 60 + currentMinute;
            const timeDifferenceInMinutes = Math.abs(currentTimeInMinutes - scheduleTimeInMinutes);

            // Check if within 30 minutes (accounting for day boundaries)
            const timeMatches =
              timeDifferenceInMinutes <= 30 || timeDifferenceInMinutes >= 24 * 60 - 30;

            logger.debug(
              `Time comparison for schedule ${schedule.scheduleId}: Current=${currentTimeInMinutes} min, Schedule=${scheduleTimeInMinutes} min, Diff=${timeDifferenceInMinutes} min, Matches=${timeMatches}`
            );

            // Check frequency
            let frequencyMatches = false;
            switch (schedule.frequency) {
              case 'DAILY':
                frequencyMatches = true;
                break;
              case 'WEEKDAYS':
                // Check if current day is Monday-Friday (1-5)
                frequencyMatches = currentDay >= 1 && currentDay <= 5;
                break;
              case 'WEEKLY':
                // For simplicity, assume weekly is on Monday
                frequencyMatches = currentDay === 1;
                break;
              case 'BIWEEKLY':
                // For simplicity, assume biweekly is on every other Monday
                // We can use the week number of the year to determine if it's an odd or even week
                const weekNumber = Math.floor(
                  (now.getTime() - new Date(now.getUTCFullYear(), 0, 1).getTime()) /
                    (7 * 24 * 60 * 60 * 1000)
                );
                frequencyMatches = currentDay === 1 && weekNumber % 2 === 0;
                break;
              case 'MONTHLY':
                // For simplicity, assume monthly is on the 1st of the month
                frequencyMatches = now.getUTCDate() === 1;
                break;
              default:
                frequencyMatches = true; // Default to true for unknown frequencies
            }

            logger.debug(
              `Frequency check for schedule ${schedule.scheduleId}: Type=${schedule.frequency}, Matches=${frequencyMatches}`
            );

            return timeMatches && frequencyMatches && shouldRunBasedOnLastUpdate;
          });

          logger.info(
            `Found ${matchingSchedules.length} schedules matching current time, frequency, and update criteria`
          );
          if (matchingSchedules.length > 0) {
            logger.info('Matching schedules:', JSON.stringify(matchingSchedules, null, 2));

            // Process each matching schedule to fetch users and send check-in requests
            for (const schedule of matchingSchedules) {
              try {
                logger.info(
                  `Processing check-in schedule: ${schedule.scheduleId} for channel: ${schedule.channelId}`
                );

                // Fetch all users in the specified channel
                const channelUsers = await this.fetchUsersInChannel(schedule.channelId);
                logger.info(`Found ${channelUsers.length} users in channel ${schedule.channelId}`);

                if (channelUsers.length === 0) {
                  logger.warn(
                    `No users found in channel ${schedule.channelId} for schedule ${schedule.scheduleId}`
                  );
                  continue;
                }

                logger.info(
                  `Users in channel ${schedule.channelId}:`,
                  JSON.stringify(channelUsers, null, 2)
                );

                await this.messageAllUsers(channelUsers);

                // Update the last updated date for the schedule
                try {
                  // Create a unique room ID for check-in schedules
                  const checkInSchedulesRoomId = createUniqueUuid(
                    this.runtime,
                    'check-in-schedules'
                  );
                  logger.info(`Updating last updated date for schedule ${schedule.scheduleId}`);

                  // Get memories from the check-in schedules room
                  const memories = await this.runtime.getMemories({
                    roomId: checkInSchedulesRoomId,
                    tableName: 'messages',
                  });

                  // Find the memory containing this schedule
                  const scheduleMemory = memories.find(
                    (memory) =>
                      memory?.content?.type === 'team-member-checkin-schedule' &&
                      memory?.content?.schedule?.scheduleId === schedule.scheduleId
                  );

                  if (scheduleMemory) {
                    // Update the last updated date
                    const updatedSchedule = {
                      ...scheduleMemory.content.schedule,
                      lastUpdated: Date.now(),
                    };

                    // Update the memory with the new schedule
                    const updatedMemory = {
                      ...scheduleMemory,
                      content: {
                        ...scheduleMemory.content,
                        schedule: updatedSchedule,
                      },
                    };

                    await this.runtime.updateMemory(updatedMemory);
                    logger.info(
                      `Successfully updated last updated date for schedule ${schedule.scheduleId}`
                    );
                  } else {
                    logger.warn(
                      `Could not find memory for schedule ${schedule.scheduleId} to update last updated date`
                    );
                  }
                } catch (updateError) {
                  logger.error(
                    `Error updating last updated date for schedule ${schedule.scheduleId}:`,
                    updateError
                  );
                }
              } catch (error) {
                logger.error(`Error processing schedule ${schedule.scheduleId}:`, error);
              }
            }
          }
        } catch (error) {
          logger.error('Failed to fetch or process check-in schedules:', error);
          logger.error('Error stack:', error.stack);
        }
      } else {
        logger.warn('Discord client not available for check-in service');
      }
    } catch (error) {
      logger.error('Error in check-in service job:', error);
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping Discord Channel Service');
    // Any cleanup logic here
  }
}

// Static start method required for service registration
TeamUpdateTrackerService.start = async (runtime: IAgentRuntime): Promise<Service> => {
  const service = new TeamUpdateTrackerService(runtime);
  await service.start();
  return service;
};

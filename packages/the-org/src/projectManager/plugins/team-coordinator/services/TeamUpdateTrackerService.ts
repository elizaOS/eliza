import {
  IAgentRuntime,
  logger,
  EventType,
  Service,
  createUniqueUuid,
  ModelType,
} from '@elizaos/core';
import type { Channel, Client, GuildChannel, TextChannel, VoiceChannel } from 'discord.js';
import { fetchCheckInSchedules } from '../actions/listCheckInSchedules';
import type { CheckInSchedule } from '../../../types';

export class TeamUpdateTrackerService extends Service {
  private client: Client | null = null;

  private telegramBot: any = null;
  private isJobRunning: boolean = false;
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
      const discordService = this.runtime.getService('discord');
      const telegramService = this.runtime.getService('telegram');

      if (discordService?.client) {
        logger.info('Discord service found, client available');
        this.client = discordService.client;
      } else {
        logger.warn(
          'Discord service not found or client not available - will try to connect later'
        );
        this.setupDiscordRetry();
      }

      if (telegramService?.bot) {
        logger.info('Telegram service found, client available');
        this.telegramBot = telegramService.bot;
      } else {
        logger.warn(
          'Telegram service not found or client not available - will try to connect later'
        );
        this.setupTelegramRetry();
      }
    } catch (error) {
      logger.error('Error initializing Discord Channel Service:', error);
    }
  }

  private setupDiscordRetry() {
    logger.info('Setting up retry for Discord service connection');
    const intervalId = setInterval(async () => {
      try {
        const discordService = this.runtime.getService('discord');
        if (discordService?.client) {
          logger.info('Discord service now available, connecting client');
          this.client = discordService.client;

          // Test the getTeamMembers function with sample server IDs
          const testServerIds = ['922791729709613096'];
          for (const serverId of testServerIds) {
            logger.info(`Testing getTeamMembers with server ID: ${serverId}`);
            this.getTeamMembers(serverId)
              .then((members) => {
                logger.info(`Found ${members.length} team members for server ${serverId}`);
                // Log all users instead of just a sample
                if (members.length > 0) {
                  logger.info('All team members data:');
                  members.forEach((member, index) => {
                    logger.info(`Member ${index + 1}:`, JSON.stringify(member));
                  });
                } else {
                  logger.info('No team members found for this server');
                }
              })
              .catch((error) => {
                logger.error(`Error fetching team members for server ${serverId}:`, error);
              });
          }

          clearInterval(intervalId);
        } else {
          logger.debug('Discord service still not available, will retry');
        }
      } catch (error) {
        logger.debug('Error checking for Discord service:', error);
      }
    }, 15000);
  }

  private setupTelegramRetry() {
    logger.info('Setting up retry for Telegram service connection');
    const intervalId = setInterval(async () => {
      try {
        const telegram = this.runtime.getService('telegram') as any;
        if (telegram?.bot) {
          logger.info('Telegram service now available, connecting bot');
          // this is a Telegraf instance
          this.telegramBot = telegram.bot;

          logger.info('Telegram bot found, fetching joined groups');

          try {
            const updates = await this.telegramBot.telegram.getMe();
            logger.info('Bot info:', updates);

            // Get all chats the bot is a member of
            logger.info('Fetching all Telegram chats...');
            // channel id : -1002524701365
            const channelId = '-1002524701365';
            logger.info('Fetching topics for channel:', channelId);
            try {
              const topics = await this.telegramBot.telegram.getChatAdministrators(channelId);
              logger.info('Channel topics:', topics);
              // 2. You can get the total count of members
              const memberCount = await this.telegramBot.telegram.getChatMembersCount(channelId);
              console.log(`Total members in channel: ${memberCount}`);

              // try {
              //   logger.info('Attempting to send message to samarth0x in channel');
              //   try {
              //     // To message in a channel where samarth0x is present
              //     const sendMessage = await this.telegramBot.telegram.sendMessage(
              //       channelId, // Using the channel ID where samarth0x is present
              //       '@samarth0x hello can you share your updates?' // Mentioning the user in the message
              //     );
              //     logger.info(
              //       'Message sent successfully in channel mentioning samarth0x:',
              //       sendMessage
              //     );
              //   } catch (channelMsgError) {
              //     logger.error('Error sending message in channel:', channelMsgError);

              //     // Try direct message if channel message fails
              //     try {
              //       logger.info('Attempting direct message to @samarth0x');
              //       const directMessage = await this.telegramBot.telegram.sendMessage(
              //         '@samarth0x',
              //         'hello can you share your updates?'
              //       );
              //       logger.info('Direct message sent successfully to @samarth0x:', directMessage);
              //     } catch (directMsgError) {
              //       logger.error('Error sending direct message to @samarth0x:', directMsgError);
              //     }
              //   }
              // }
            } catch (error) {
              logger.error('Error sending Telegram message:', error);
              // The error in logs shows "chat not found" which might mean we need a chat ID instead of username
              logger.info('Note: Telegram might require a numeric chat ID instead of a username');
            }
          } catch (err) {
            logger.error('Error fetching Telegram groups:', err);
          }

          clearInterval(intervalId);
        } else {
          logger.debug('Telegram service still not available, will retry');
        }
      } catch (error) {
        logger.debug('Error checking for Telegram service:', error);
      }
    }, 15000);
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
    users: Array<{
      id: string;
      username: string;
      displayName: string;
      channelName: string;
      updatesFormat?: string[];
    }>,
    schedule: CheckInSchedule,
    serverName?: string
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

          // Create the message format based on user's updatesFormat if available
          let updateFormatMessage = '';

          if (user.updatesFormat && user.updatesFormat.length > 0) {
            // Use custom format from user's updatesFormat
            updateFormatMessage = user.updatesFormat
              .map((field) => `- **${field}**\n    - Text`)
              .join('\n');
          } else {
            // Use default format
            updateFormatMessage =
              `- **Main Priority for next week**\n` +
              `    - Text\n` +
              `- **What did you get done this week?**\n` +
              `    - Text\n` +
              `- **Blockers**\n` +
              `    - Text`;
          }

          await discordUser.send(
            `Hi ${user.displayName}! It's ${new Date().toLocaleString('en-US', { weekday: 'long' })}. Please share your latest updates for the ${user.channelName} channel.\n\n` +
              `Please use the following format for your update:\n` +
              `**Server-name**: ${serverName}\n\n` +
              `**Check-in Type**: ${schedule.checkInType}\n\n` +
              `${updateFormatMessage}\n\n` +
              `Important: End your message with "sending my personal updates" so it can be properly tracked.`
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

  /**
   * Fetches team members for a specific server from memory
   * @param serverId The ID of the server to fetch team members for
   * @param platform Optional platform filter ('discord' or 'telegram')
   * @returns An array of team members with their details
   */
  public async getTeamMembers(
    serverId: string,
    platform?: 'discord' | 'telegram'
  ): Promise<
    Array<{
      username: string;
      section: string;
      platform: string;
      updatesFormat?: string[];
    }>
  > {
    try {
      logger.info(
        `Fetching team members for server ${serverId}${platform ? ` on ${platform}` : ''}`
      );

      // Create the consistent room ID for storing team members
      const serverHash = serverId.replace(/[^a-zA-Z0-9]/g, '');
      const roomIdForStoringTeamMembers = createUniqueUuid(
        this.runtime,
        `store-team-members-${serverHash}`
      );

      logger.info(`Looking for team members in room: ${roomIdForStoringTeamMembers}`);

      // Get memories from the team members storage room
      const memories = await this.runtime.getMemories({
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
        return [];
      }

      // Extract team members
      const teamMembers = teamMembersConfig.content.config.teamMembers as Array<{
        section: string;
        tgName?: string;
        discordName?: string;
        updatesFormat?: string[];
        serverId: string;
      }>;

      logger.info(`Found ${teamMembers.length} team members for server ${serverId}`);

      // Filter by platform if specified
      const filteredMembers = platform
        ? teamMembers.filter(
            (member) =>
              (platform === 'discord' && member.discordName) ||
              (platform === 'telegram' && member.tgName)
          )
        : teamMembers;

      // Format the response
      return filteredMembers.map((member) => ({
        username: member.discordName || member.tgName || 'Unknown',
        section: member.section || 'Unassigned',
        platform: member.discordName ? 'discord' : member.tgName ? 'telegram' : 'unknown',
        updatesFormat: member.updatesFormat || [],
      }));
    } catch (error) {
      logger.error(`Error fetching team members for server ${serverId}:`, error);
      logger.error(`Error stack: ${error.stack}`);
      return [];
    }
  }

  // biome-ignore lint/complexity/noUselessLoneBlockStatements: <explanation>
  public async checkInServiceJob(): Promise<void> {
    if (this.isJobRunning) {
      logger.info('Check-in service job already running, skipping this execution');
      return;
    }

    this.isJobRunning = true;
    try {
      logger.info('Running check-in service job');
      const discordService: any = this.runtime.getService('discord');
      const telegramService: any = this.runtime.getService('telegram');

      if (discordService?.client) {
        logger.info('Discord service now available, connecting client');
        this.client = discordService.client;
      }

      if (telegramService?.bot) {
        logger.info('Telegram service found, client available');
        this.telegramBot = telegramService.bot;
      }

      // Dummy function for check-in service
      if (this.client) {
        logger.info('Discord client is available for check-in service');
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

            logger.info(
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

            logger.info(
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

                logger.info(`Schedule source: ${schedule.source}`);

                // Get Discord service to fetch server info
                const discordService = this.runtime.getService('discord') as IDiscordService | null;

                // Find the server containing this channel
                let serverName;

                if (discordService?.client) {
                  logger.info('Discord service client is available');

                  for (const [, guild] of discordService.client.guilds.cache) {
                    const channels = await guild.channels.fetch();
                    const channel = channels.find((ch) => {
                      return (
                        ch && typeof ch === 'object' && 'id' in ch && ch.id === schedule.channelId
                      );
                    });

                    if (channel) {
                      serverName = guild.name;
                      logger.info(`Found channel in server: ${serverName}`);
                      break;
                    }
                  }
                } else {
                  logger.info('Discord service or client not available');
                }

                // Check if source is Telegram
                if (schedule?.source === 'telegram') {
                  logger.info(`Telegram source detected for schedule ${schedule.scheduleId}`);

                  if (!this.telegramBot?.telegram) {
                    continue;
                  }

                  logger.info(
                    `Preparing to send update request to Telegram group ${schedule.serverId}`
                  );

                  // Get team members for this server
                  const teamMembers = await this.getTeamMembers(schedule.serverId, 'telegram');
                  logger.info(
                    `Found ${teamMembers.length} team members for Telegram server ${schedule.serverId}`
                  );

                  // Create mentions for team members
                  let mentions = '';
                  if (teamMembers.length > 0) {
                    mentions = 'Tagging team members: ';
                    for (const member of teamMembers) {
                      if (member.username) {
                        mentions += `${member.username} `;
                      }
                    }
                    mentions += '\n\n';
                  }
                  const updateRequestMessage =
                    `📢 *Team Update Request*\n\n${mentions}Hello team! I need your updates for this check-in.\n\n` +
                    `*Check-in Type*: ${schedule.checkInType}\n\n` +
                    `Please send me a direct message with your updates. To get started, message me with "Can you share the format for updates?" and I will provide you with the template.\n\n`;

                  await this.telegramBot.telegram.sendMessage(
                    schedule.serverId,
                    updateRequestMessage,
                    { parse_mode: 'Markdown' }
                  );
                  logger.info(
                    `Sent formatted update request to Telegram group ${schedule.serverId} with ${teamMembers.length} tagged members`
                  );

                  logger.info(
                    `Successfully sent group check-in message to Telegram channel ${schedule.channelId}`
                  );
                } else {
                  // For Discord or other sources, continue with the original flow
                  // Get team members for this server from memory instead of all channel users
                  const teamMembers = await this.getTeamMembers(schedule.serverId, 'discord');

                  logger.info(
                    `Found ${teamMembers.length} team members for Discord server ${schedule.serverId}`
                  );

                  if (teamMembers.length === 0) {
                    logger.warn(
                      `No team members found for server ${schedule.serverId} (${serverName}) for schedule ${schedule.scheduleId}`
                    );
                    continue;
                  }

                  // Fetch users in the channel
                  const channelUsers = await this.fetchUsersInChannel(schedule.channelId);
                  logger.info(
                    `Fetched ${channelUsers.length} users from channel ${schedule.channelId}`
                  );

                  // Match channel users with team members
                  const usersToMessage = [];
                  for (const teamMember of teamMembers) {
                    // Extract username from discordName (after @)
                    const discordUsername = teamMember.username?.startsWith('@')
                      ? teamMember.username.substring(1)
                      : teamMember.username;

                    if (!discordUsername) {
                      logger.warn(
                        `Team member in section ${teamMember.section} has no Discord username`
                      );
                      continue;
                    }

                    // Find matching user in channel
                    const matchingUser = channelUsers.find(
                      (user) =>
                        user.username === discordUsername || user.displayName === discordUsername
                    );

                    if (matchingUser) {
                      // Log the custom update format if available
                      if (teamMember.updatesFormat && teamMember.updatesFormat.length > 0) {
                        logger.info(
                          `Team member ${discordUsername} has custom update format: ${JSON.stringify(
                            teamMember.updatesFormat
                          )}`
                        );
                      } else {
                        logger.debug(`Team member ${discordUsername} using default update format`);
                      }
                      usersToMessage.push({
                        ...matchingUser,
                        updatesFormat: teamMember.updatesFormat,
                      });
                      logger.info(
                        `Matched team member ${discordUsername} with channel user ${matchingUser.displayName}`
                      );
                    } else {
                      logger.warn(
                        `Could not find channel user matching team member ${discordUsername}`
                      );
                    }
                  }

                  logger.info(`Sending messages to ${usersToMessage.length} matched users`);

                  // Send messages to matched users
                  if (usersToMessage.length > 0) {
                    const successfullyMessaged = await this.messageAllUsers(
                      usersToMessage,
                      schedule,
                      serverName
                    );

                    logger.info(
                      `Successfully sent messages to ${successfullyMessaged.length} users`
                    );
                  } else {
                    logger.warn(
                      `No matching users found to message for server ${schedule.serverId}`
                    );
                  }
                }

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
    } finally {
      this.isJobRunning = false;
    }
  }

  async stop(): Promise<void> {
    logger.info('Stopping Discord Channel Service');
  }
}

// Static start method required for service registration
TeamUpdateTrackerService.start = async (runtime: IAgentRuntime): Promise<Service> => {
  const service = new TeamUpdateTrackerService(runtime);
  await service.start();
  return service;
};

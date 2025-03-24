import { IAgentRuntime, logger, EventType, Service } from '@elizaos/core';
import type { Channel, Client, GuildChannel, TextChannel, VoiceChannel } from 'discord.js';

export class DiscordChannelService extends Service {
  private client: Client | null = null;
  static serviceType = 'discord-channel-service';
  capabilityDescription = 'Manages Discord channel information and events';
  // Store available Discord channels
  private textChannels: Array<{ id: string; name: string; type: string }> = [];

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.initializeEventListeners();
  }

  async start(): Promise<void> {
    logger.info('Starting Discord Channel Service');
    try {
      // Try to get the Discord service - it might not be available yet
      const discordService = this.runtime.getService('discord');
      if (discordService?.client) {
        logger.info('Discord service found, client available');
        this.client = discordService.client;
      } else {
        logger.warn(
          'Discord service not found or client not available - will try to connect later'
        );

        // Set up a retry mechanism for when Discord becomes available
        this.setupDiscordRetry();
      }
    } catch (error) {
      logger.error('Error initializing Discord Channel Service:', error);
    }
  }

  private setupDiscordRetry() {
    // Check for Discord service every 30 seconds
    logger.info('Setting up retry for Discord service connection');
    const intervalId = setInterval(() => {
      try {
        const discordService = this.runtime.getService('discord');
        if (discordService?.client) {
          logger.info('Discord service now available, connecting client');
          this.client = discordService.client;
          clearInterval(intervalId);
        } else {
          logger.debug('Discord service still not available, will retry');
        }
      } catch (error) {
        logger.debug('Error checking for Discord service:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  async stop(): Promise<void> {
    logger.info('Stopping Discord Channel Service');
    // Any cleanup logic here
  }

  // Method to get available text channels for forms
  getTextChannels(): Array<{ id: string; name: string; type: string }> {
    logger.debug(`Returning ${this.textChannels.length} available text channels`);
    return this.textChannels;
  }

  private initializeEventListeners() {
    logger.info('=== INITIALIZING DISCORD CHANNEL SERVICE ===');

    this.runtime.registerEvent(EventType.WORLD_CONNECTED, async (event) => {
      try {
        logger.info('🌎 World Connected Event Received:', {
          worldName: event.world.name,
          worldId: event.world.id,
          serverId: event.world.serverId,
        });

        // Log all the event data for debugging
        logger.debug('Full World Connected Event Data:', {
          rooms: event.rooms?.length || 0,
          entities: event.entities?.length || 0,
          source: event.source,
          hasMetadata: !!event.world.metadata,
        });

        // Extract and map all users/entities
        const allUsers = event.entities || [];
        const usersMap = new Map();

        // Create a map of users for easy lookup
        for (const user of allUsers) {
          usersMap.set(user.id, {
            id: user.id,
            name: user.name,
            roles: user.roles || [],
            isBot: user.isBot || false,
          });

          logger.debug(`Mapped user: ${user.name} (${user.id})`);
        }

        logger.info(`👥 Total Users: ${allUsers.length}`);
        console.log(allUsers, 'allusers');

        // Log the first user to see its structure
        if (allUsers.length > 0) {
          logger.debug('First user example:', JSON.stringify(allUsers[0], null, 2));
        }

        // Log more detailed debug information about users and connections
        logger.debug(
          'All users:',
          JSON.stringify(
            allUsers.map((u) => ({ id: u.id, name: u.name })),
            null,
            2
          )
        );

        // Process channels and add user information where available
        if (event.rooms) {
          // Log raw room connections debug info
          for (const room of event.rooms) {
            if (room.connections) {
              logger.debug(
                `Room ${room.name} has ${room.connections.length} connections:`,
                JSON.stringify(room.connections, null, 2)
              );
            } else {
              logger.debug(`Room ${room.name} has NO connections array`);
            }
          }

          const channelsWithUsers = [];
          // Reset text channels array on each WORLD_CONNECTED event
          this.textChannels = [];

          for (const room of event.rooms) {
            // Basic channel info
            const channelInfo = {
              id: room.id,
              name: room.name,
              type: room.type,
              channelId: room.channelId,
              users: [],
            };

            // Find users in this channel if they exist
            if (room.connections) {
              for (const connection of room.connections) {
                const userId = connection.entityId;
                const user = usersMap.get(userId);

                if (user) {
                  channelInfo.users.push(user);
                  logger.debug(`Added user ${user.name} to channel ${room.name}`);
                } else {
                  logger.debug(
                    `User with ID ${userId} not found in usersMap for channel ${room.name}`
                  );
                }
              }

              logger.debug(`Channel ${room.name} has ${channelInfo.users.length} users`);
            } else {
              logger.debug(`No connections found for channel ${room.name}`);
            }

            channelsWithUsers.push(channelInfo);

            // Save text channels for form selection
            if (room.type === 'GROUP') {
              this.textChannels.push({
                id: room.id,
                name: room.name,
                type: room.type,
              });
              logger.debug(`Added text channel: ${room.name} (${room.id})`);
            }
          }

          logger.info(`💬 Available Text Channels: ${this.textChannels.length}`);
          logger.debug('Text Channels:', JSON.stringify(this.textChannels, null, 2));

          // Log the final result with channels and their users
          logger.info('📢 Channels with Users:', JSON.stringify(channelsWithUsers, null, 2));

          // get channel wise users

          logger.info('channel wise user :');
          const channelWiseUser = await getTextChannelMembers();

          // Also log a summary of active voice channels
          const activeVoiceChannels = channelsWithUsers.filter(
            (channel) => channel.type === 'VOICE' && channel.users.length > 0
          );

          if (activeVoiceChannels.length > 0) {
            logger.info(
              '🔊 Active Voice Channels:',
              JSON.stringify(
                activeVoiceChannels.map((channel) => ({
                  name: channel.name,
                  userCount: channel.users.length,
                  users: channel.users.map((u) => u.name),
                })),
                null,
                2
              )
            );
          } else {
            logger.info('No active voice channels with users found');
          }
        }
      } catch (error) {
        logger.error('Error processing WORLD_CONNECTED event:', error);
        logger.error('Error stack:', error.stack);
      }
    });

    logger.info('Discord Channel Service event listeners initialized successfully');
  }
}

// Static start method required for service registration
DiscordChannelService.start = async (runtime: IAgentRuntime): Promise<Service> => {
  const service = new DiscordChannelService(runtime);
  await service.start();
  return service;
};

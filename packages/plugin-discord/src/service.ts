import {
  ChannelType,
  type Character,
  type Entity,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  Role,
  Service,
  type UUID,
  type World,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import {
  type Channel,
  ChannelType as DiscordChannelType,
  Client as DiscordJsClient,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildMember,
  type MessageReaction,
  type OAuth2Guild,
  type PartialMessageReaction,
  type PartialUser,
  Partials,
  PermissionsBitField,
  type TextChannel,
  type User,
} from 'discord.js';
import { DISCORD_SERVICE_NAME } from './constants';
import { MessageManager } from './messages';
import { DiscordEventTypes, type IDiscordService } from './types';
import { VoiceManager } from './voice';

/**
 * DiscordService class representing a service for interacting with Discord.
 * @extends Service
 * @implements IDiscordService
 * @property {string} serviceType - The type of service, set to DISCORD_SERVICE_NAME.
 * @property {string} capabilityDescription - A description of the service's capabilities.
 * @property {DiscordJsClient} client - The DiscordJsClient used for communication.
 * @property {Character} character - The character associated with the service.
 * @property {MessageManager} messageManager - The manager for handling messages.
 * @property {VoiceManager} voiceManager - The manager for handling voice communication.
 */

export class DiscordService extends Service implements IDiscordService {
  static serviceType: string = DISCORD_SERVICE_NAME;
  capabilityDescription = 'The agent is able to send and receive messages on discord';
  client: DiscordJsClient;
  character: Character;
  messageManager: MessageManager;
  voiceManager: VoiceManager;

  /**
   * Constructor for Discord client.
   * Initializes the Discord client with specified intents and partials,
   * sets up event listeners, and ensures all servers exist.
   *
   * @param {IAgentRuntime} runtime - The AgentRuntime instance
   */
  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Check if Discord API token is available and valid
    const token = runtime.getSetting('DISCORD_API_TOKEN') as string;
    if (!token || token.trim() === '') {
      logger.warn('Discord API Token not provided - Discord functionality will be unavailable');
      this.client = null;
      return;
    }

    try {
      this.client = new DiscordJsClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildPresences,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessageTyping,
          GatewayIntentBits.GuildMessageTyping,
          GatewayIntentBits.GuildMessageReactions,
        ],
        partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction],
      });

      this.runtime = runtime;
      this.voiceManager = new VoiceManager(this, runtime);
      this.messageManager = new MessageManager(this);

      this.client.once(Events.ClientReady, this.onClientReady.bind(this));
      this.client.login(token).catch((error) => {
        logger.error(`Failed to login to Discord: ${error.message}`);
        this.client = null;
      });

      this.setupEventListeners();
    } catch (error) {
      logger.error(`Error initializing Discord client: ${error.message}`);
      this.client = null;
    }
  }

  /**
   * Set up event listeners for the client
   */
  private setupEventListeners() {
    if (!this.client) {
      return; // Skip if client is not available
    }

    // Setup handling for direct messages
    this.client.on('messageCreate', (message) => {
      // Skip if we're sending the message or in deleted state
      if (message.author.id === this.client?.user?.id || message.author.bot) {
        return;
      }

      try {
        this.messageManager.handleMessage(message);
      } catch (error) {
        logger.error(`Error handling message: ${error}`);
      }
    });

    // Setup handling for reactions
    this.client.on('messageReactionAdd', async (reaction, user) => {
      if (user.id === this.client?.user?.id) {
        return;
      }
      try {
        await this.handleReactionAdd(reaction, user);
      } catch (error) {
        logger.error(`Error handling reaction add: ${error}`);
      }
    });

    // Handle reaction removal
    this.client.on('messageReactionRemove', async (reaction, user) => {
      if (user.id === this.client?.user?.id) {
        return;
      }
      try {
        await this.handleReactionRemove(reaction, user);
      } catch (error) {
        logger.error(`Error handling reaction remove: ${error}`);
      }
    });

    // Setup guild (server) event handlers
    this.client.on('guildCreate', async (guild) => {
      try {
        await this.handleGuildCreate(guild);
      } catch (error) {
        logger.error(`Error handling guild create: ${error}`);
      }
    });

    // Setup member (user) joining handlers
    this.client.on('guildMemberAdd', async (member) => {
      try {
        await this.handleGuildMemberAdd(member);
      } catch (error) {
        logger.error(`Error handling guild member add: ${error}`);
      }
    });

    // Interaction handlers
    this.client.on('interactionCreate', async (interaction) => {
      try {
        await this.handleInteractionCreate(interaction);
      } catch (error) {
        logger.error(`Error handling interaction: ${error}`);
      }
    });

    this.client.on('userStream', (entityId, name, userName, channel, opusDecoder) => {
      if (entityId !== this.client?.user?.id) {
        this.voiceManager.handleUserStream(entityId, name, userName, channel, opusDecoder);
      }
    });
  }

  /**
   * Handles the event when a new member joins a guild.
   *
   * @param {GuildMember} member - The GuildMember object representing the new member that joined the guild.
   * @returns {Promise<void>} - A Promise that resolves once the event handling is complete.
   */
  private async handleGuildMemberAdd(member: GuildMember) {
    logger.log(`New member joined: ${member.user.username}`);

    const guild = member.guild;

    const tag = member.user.bot
      ? `${member.user.username}#${member.user.discriminator}`
      : member.user.username;

    const worldId = createUniqueUuid(this.runtime, guild.id);
    const entityId = createUniqueUuid(this.runtime, member.id);

    // Emit standardized ENTITY_JOINED event
    this.runtime.emitEvent([EventType.ENTITY_JOINED], {
      runtime: this.runtime,
      entityId,
      worldId,
      source: 'discord',
      metadata: {
        originalId: member.id,
        username: tag,
        displayName: member.displayName || member.user.username,
        roles: member.roles.cache.map((r) => r.name),
        joinedAt: member.joinedAt?.getTime(),
      },
    });

    // Emit Discord-specific event
    this.runtime.emitEvent([DiscordEventTypes.ENTITY_JOINED], {
      runtime: this.runtime,
      entityId,
      worldId,
      member,
      guild,
    });
  }

  /**
   *
   * Start the Discord service
   * @param {IAgentRuntime} runtime - The runtime for the agent
   * @returns {Promise<DiscordService>} A promise that resolves to a DiscordService instance
   *
   */
  static async start(runtime: IAgentRuntime): Promise<DiscordService> {
    const token = runtime.getSetting('DISCORD_API_TOKEN') as string;
    if (!token || token.trim() === '') {
      throw new Error('Discord API Token not provided');
    }

    const maxRetries = 5;
    let retryCount = 0;
    let lastError: Error | null = null;

    while (retryCount < maxRetries) {
      try {
        const service = new DiscordService(runtime);
        if (!service.client) {
          throw new Error('Failed to initialize Discord client');
        }

        // Wait for client to be ready
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Discord client ready timeout'));
          }, 30000); // 30 second timeout

          service.client?.once('ready', () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        return service;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `Discord initialization attempt ${retryCount + 1} failed: ${lastError.message}`
        );
        retryCount++;

        if (retryCount < maxRetries) {
          const delay = 2 ** retryCount * 1000; // Exponential backoff
          logger.info(`Retrying Discord initialization in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Discord initialization failed after ${maxRetries} attempts. Last error: ${lastError?.message}`
    );
  }

  /**
   * Stops the Discord client associated with the given runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime associated with the Discord client.
   * @returns {void}
   */
  static async stop(runtime: IAgentRuntime) {
    const client = runtime.getService(DISCORD_SERVICE_NAME);
    if (!client) {
      logger.error('DiscordService not found');
      return;
    }
    try {
      // disconnect websocket
      // this unbinds all the listeners
      await client.stop();
    } catch (e) {
      logger.error('client-discord instance stop err', e);
    }
  }

  /**
   * Asynchronously stops the client by destroying it.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    await this.client?.destroy();
  }

  /**
   * Handle the event when the client is ready.
   * @param {Object} readyClient - The ready client object containing user information.
   * @param {string} readyClient.user.tag - The username and discriminator of the client user.
   * @param {string} readyClient.user.id - The user ID of the client.
   * @returns {Promise<void>}
   */
  private async onClientReady(readyClient: { user: { tag: any; id: any } }) {
    logger.success(`DISCORD: Logged in as ${readyClient.user?.tag}`);

    // Register slash commands
    const commands = [
      {
        name: 'joinchannel',
        description: 'Join a voice channel',
        options: [
          {
            name: 'channel',
            type: 7, // CHANNEL type
            description: 'The voice channel to join',
            required: true,
            channel_types: [2], // GuildVoice type
          },
        ],
      },
      {
        name: 'leavechannel',
        description: 'Leave the current voice channel',
      },
    ];

    try {
      await this.client?.application?.commands.set(commands);
      logger.success('DISCORD: Slash commands registered');
    } catch (error) {
      console.error('Error registering slash commands:', error);
    }

    // Required permissions for the bot
    const requiredPermissions = [
      // Text Permissions
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendMessagesInThreads,
      PermissionsBitField.Flags.CreatePrivateThreads,
      PermissionsBitField.Flags.CreatePublicThreads,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.AddReactions,
      PermissionsBitField.Flags.UseExternalEmojis,
      PermissionsBitField.Flags.UseExternalStickers,
      PermissionsBitField.Flags.MentionEveryone,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
      // Voice Permissions
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
      PermissionsBitField.Flags.UseVAD,
      PermissionsBitField.Flags.PrioritySpeaker,
    ].reduce((a, b) => a | b, 0n);

    logger.success('Use this URL to add the bot to your server:');
    logger.success(
      `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user?.id}&permissions=${requiredPermissions}&scope=bot%20applications.commands`
    );
    await this.onReady();
  }

  /**
   * Asynchronously retrieves the type of a given channel.
   *
   * @param {Channel} channel - The channel for which to determine the type.
   * @returns {Promise<ChannelType>} A Promise that resolves with the type of the channel.
   */
  async getChannelType(channel: Channel): Promise<ChannelType> {
    switch (channel.type) {
      case DiscordChannelType.DM:
        return ChannelType.DM;
      case DiscordChannelType.GuildText:
        return ChannelType.GROUP;
      case DiscordChannelType.GuildVoice:
        return ChannelType.VOICE_GROUP;
    }
  }

  /**
   * Handles the addition of a reaction on a message.
   *
   * @param {MessageReaction | PartialMessageReaction} reaction The reaction that was added.
   * @param {User | PartialUser} user The user who added the reaction.
   * @returns {void}
   */
  async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    try {
      logger.log('Reaction added');

      // Early returns
      if (!reaction || !user) {
        logger.warn('Invalid reaction or user');
        return;
      }

      // Get emoji info
      let emoji = reaction.emoji.name;
      if (!emoji && reaction.emoji.id) {
        emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
      }

      // Fetch full message if partial
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          logger.error('Failed to fetch partial reaction:', error);
          return;
        }
      }

      // Generate IDs with timestamp to ensure uniqueness
      const timestamp = Date.now();
      const roomId = createUniqueUuid(this.runtime, reaction.message.channel.id);
      const entityId = createUniqueUuid(this.runtime, user.id);
      const reactionUUID = createUniqueUuid(
        this.runtime,
        `${reaction.message.id}-${user.id}-${emoji}-${timestamp}`
      );

      // Validate IDs
      if (!entityId || !roomId) {
        logger.error('Invalid user ID or room ID', {
          entityId,
          roomId,
        });
        return;
      }

      // Process message content
      const messageContent = reaction.message.content || '';
      const truncatedContent =
        messageContent.length > 50 ? `${messageContent.substring(0, 50)}...` : messageContent;
      const reactionMessage = `*Added <${emoji}> to: "${truncatedContent}"*`;

      // Get user info
      const userName = reaction.message.author?.username || 'unknown';
      const name = reaction.message.author?.displayName || userName;

      // TODO: Get the type of the channel
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        name: name,
        source: 'discord',
        channelId: reaction.message.channel.id,
        serverId: reaction.message.guild?.id,
        type: await this.getChannelType(reaction.message.channel as Channel),
      });

      const inReplyTo = createUniqueUuid(this.runtime, reaction.message.id);

      const memory: Memory = {
        id: reactionUUID,
        entityId,
        agentId: this.runtime.agentId,
        content: {
          // name,
          // userName,
          text: reactionMessage,
          source: 'discord',
          inReplyTo,
          channelType: await this.getChannelType(reaction.message.channel as Channel),
        },
        roomId,
        createdAt: timestamp,
      };

      const callback: HandlerCallback = async (content) => {
        if (!reaction.message.channel) {
          logger.error('No channel found for reaction message');
          return;
        }
        await (reaction.message.channel as TextChannel).send(content.text);
        return [];
      };

      this.runtime.emitEvent(['DISCORD_REACTION_RECEIVED', 'REACTION_RECEIVED'], {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      logger.error('Error handling reaction:', error);
    }
  }

  /**
   * Handles the removal of a reaction on a message.
   *
   * @param {MessageReaction | PartialMessageReaction} reaction - The reaction that was removed.
   * @param {User | PartialUser} user - The user who removed the reaction.
   * @returns {Promise<void>} - A Promise that resolves after handling the reaction removal.
   */
  async handleReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    try {
      logger.log('Reaction removed');

      let emoji = reaction.emoji.name;
      if (!emoji && reaction.emoji.id) {
        emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
      }

      // Fetch the full message if it's a partial
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          logger.error('Something went wrong when fetching the message:', error);
          return;
        }
      }

      const messageContent = reaction.message.content || '';
      const truncatedContent =
        messageContent.length > 50 ? `${messageContent.substring(0, 50)}...` : messageContent;

      const reactionMessage = `*Removed <${emoji}> from: "${truncatedContent}"*`;

      const roomId = createUniqueUuid(this.runtime, reaction.message.channel.id);

      const entityId = createUniqueUuid(this.runtime, user.id);
      const timestamp = Date.now();
      const reactionUUID = createUniqueUuid(
        this.runtime,
        `${reaction.message.id}-${user.id}-${emoji}-${timestamp}`
      );

      const userName = reaction.message.author?.username || 'unknown';
      const name = reaction.message.author?.displayName || userName;

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        name: name,
        source: 'discord',
        channelId: reaction.message.channel.id,
        serverId: reaction.message.guild?.id,
        type: await this.getChannelType(reaction.message.channel as Channel),
      });

      const memory: Memory = {
        id: reactionUUID,
        entityId,
        agentId: this.runtime.agentId,
        content: {
          // name,
          // userName,
          text: reactionMessage,
          source: 'discord',
          inReplyTo: createUniqueUuid(this.runtime, reaction.message.id),
          channelType: await this.getChannelType(reaction.message.channel as Channel),
        },
        roomId,
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (content) => {
        if (!reaction.message.channel) {
          logger.error('No channel found for reaction message');
          return;
        }
        await (reaction.message.channel as TextChannel).send(content.text);
        return [];
      };

      this.runtime.emitEvent([DiscordEventTypes.REACTION_RECEIVED], {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      logger.error('Error handling reaction removal:', error);
    }
  }

  /**
   * Handles the event when the bot joins a guild. It logs the guild name, fetches additional information about the guild, scans the guild for voice data, creates standardized world data structure, generates unique IDs, and emits events to the runtime.
   * @param {Guild} guild - The guild that the bot has joined.
   * @returns {Promise<void>}
   */
  private async handleGuildCreate(guild: Guild) {
    logger.log(`Joined guild ${guild.name}`);
    const fullGuild = await guild.fetch();
    this.voiceManager.scanGuild(guild);

    const ownerId = createUniqueUuid(this.runtime, fullGuild.ownerId);

    // Create standardized world data structure
    const worldId = createUniqueUuid(this.runtime, fullGuild.id);
    const standardizedData = {
      runtime: this.runtime,
      rooms: await this.buildStandardizedRooms(fullGuild, worldId),
      users: await this.buildStandardizedUsers(fullGuild),
      world: {
        id: worldId,
        name: fullGuild.name,
        agentId: this.runtime.agentId,
        serverId: fullGuild.id,
        metadata: {
          ownership: fullGuild.ownerId ? { ownerId: ownerId } : undefined,
          roles: {
            [ownerId]: Role.OWNER,
          },
        },
      } as World,
      source: 'discord',
    };

    // Emit both Discord-specific and standardized events with the same data structure
    this.runtime.emitEvent([DiscordEventTypes.WORLD_JOINED], {
      runtime: this.runtime,
      server: fullGuild,
      source: 'discord',
    });

    // Emit standardized event with the same structure as WORLD_CONNECTED
    this.runtime.emitEvent([EventType.WORLD_JOINED], standardizedData);
  }

  /**
   * Handles interactions created by the user, specifically commands.
   * @param {any} interaction - The interaction object received
   * @returns {void}
   */
  private async handleInteractionCreate(interaction: any) {
    if (!interaction.isCommand()) return;

    switch (interaction.commandName) {
      case 'joinchannel':
        await this.voiceManager.handleJoinChannelCommand(interaction);
        break;
      case 'leavechannel':
        await this.voiceManager.handleLeaveChannelCommand(interaction);
        break;
    }
  }

  /**
   * Builds a standardized list of rooms from Discord guild channels
   */
  /**
   * Build standardized rooms for a guild based on text and voice channels.
   *
   * @param {Guild} guild The guild to build rooms for.
   * @param {UUID} _worldId The ID of the world to associate with the rooms.
   * @returns {Promise<any[]>} An array of standardized room objects.
   */
  private async buildStandardizedRooms(guild: Guild, _worldId: UUID): Promise<any[]> {
    const rooms = [];

    for (const [channelId, channel] of guild.channels.cache) {
      // Only process text and voice channels
      if (
        channel.type === DiscordChannelType.GuildText ||
        channel.type === DiscordChannelType.GuildVoice
      ) {
        const roomId = createUniqueUuid(this.runtime, channelId);
        let channelType;

        switch (channel.type) {
          case DiscordChannelType.GuildText:
            channelType = ChannelType.GROUP;
            break;
          case DiscordChannelType.GuildVoice:
            channelType = ChannelType.VOICE_GROUP;
            break;
          default:
            channelType = ChannelType.GROUP;
        }

        // For text channels, we could potentially get member permissions
        // But for performance reasons, keep this light for large guilds
        let participants: UUID[] = [];

        if (guild.memberCount < 1000 && channel.type === DiscordChannelType.GuildText) {
          try {
            // Only attempt this for smaller guilds
            // Get members with read permissions for this channel
            participants = Array.from(guild.members.cache.values())
              .filter((member) =>
                channel.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel)
              )
              .map((member) => createUniqueUuid(this.runtime, member.id));
          } catch (error) {
            logger.warn(`Failed to get participants for channel ${channel.name}:`, error);
          }
        }

        rooms.push({
          id: roomId,
          name: channel.name,
          type: channelType,
          channelId: channel.id,
          participants,
        });
      }
    }

    return rooms;
  }

  /**
   * Builds a standardized list of users from Discord guild members
   */
  private async buildStandardizedUsers(guild: Guild): Promise<Entity[]> {
    const entities: Entity[] = [];
    const botId = this.client?.user?.id;

    // Strategy based on guild size
    if (guild.memberCount > 1000) {
      logger.info(
        `Using optimized user sync for large guild ${guild.name} (${guild.memberCount} members)`
      );

      // For large guilds, prioritize members already in cache + online members
      try {
        // Use cache first
        for (const [, member] of guild.members.cache) {
          const tag = member.user.bot
            ? `${member.user.username}#${member.user.discriminator}`
            : member.user.username;

          if (member.id !== botId) {
            entities.push({
              id: createUniqueUuid(this.runtime, member.id),
              names: Array.from(
                new Set([member.user.username, member.displayName, member.user.globalName])
              ),
              agentId: this.runtime.agentId,
              metadata: {
                default: {
                  username: tag,
                  name: member.displayName || member.user.username,
                },
                discord: member.user.globalName
                  ? {
                      username: tag,
                      name: member.displayName || member.user.username,
                      globalName: member.user.globalName,
                      userId: member.id,
                    }
                  : {
                      username: tag,
                      name: member.displayName || member.user.username,
                      userId: member.id,
                    },
              },
            });
          }
        }

        // If cache has very few members, try to get online members
        if (entities.length < 100) {
          logger.info(`Adding online members for ${guild.name}`);
          // This is a more targeted fetch that is less likely to hit rate limits
          const onlineMembers = await guild.members.fetch({ limit: 100 });

          for (const [, member] of onlineMembers) {
            if (member.id !== botId) {
              const entityId = createUniqueUuid(this.runtime, member.id);
              // Avoid duplicates
              if (!entities.some((u) => u.id === entityId)) {
                const tag = member.user.bot
                  ? `${member.user.username}#${member.user.discriminator}`
                  : member.user.username;

                entities.push({
                  id: entityId,
                  names: Array.from(
                    new Set([member.user.username, member.displayName, member.user.globalName])
                  ),
                  agentId: this.runtime.agentId,
                  metadata: {
                    default: {
                      username: tag,
                      name: member.displayName || member.user.username,
                    },
                    discord: member.user.globalName
                      ? {
                          username: tag,
                          name: member.displayName || member.user.username,
                          globalName: member.user.globalName,
                          userId: member.id,
                        }
                      : {
                          username: tag,
                          name: member.displayName || member.user.username,
                          userId: member.id,
                        },
                  },
                });
              }
            }
          }
        }
      } catch (error) {
        logger.error(`Error fetching members for ${guild.name}:`, error);
      }
    } else {
      // For smaller guilds, we can fetch all members
      try {
        let members = guild.members.cache;
        if (members.size === 0) {
          members = await guild.members.fetch();
        }

        for (const [, member] of members) {
          if (member.id !== botId) {
            const tag = member.user.bot
              ? `${member.user.username}#${member.user.discriminator}`
              : member.user.username;

            entities.push({
              id: createUniqueUuid(this.runtime, member.id),
              names: Array.from(
                new Set([member.user.username, member.displayName, member.user.globalName])
              ),
              agentId: this.runtime.agentId,
              metadata: {
                default: {
                  username: tag,
                  name: member.displayName || member.user.username,
                },
                discord: member.user.globalName
                  ? {
                      username: tag,
                      name: member.displayName || member.user.username,
                      globalName: member.user.globalName,
                      userId: member.id,
                    }
                  : {
                      username: tag,
                      name: member.displayName || member.user.username,
                      userId: member.id,
                    },
              },
            });
          }
        }
      } catch (error) {
        logger.error(`Error fetching members for ${guild.name}:`, error);
      }
    }

    return entities;
  }

  private async onReady() {
    logger.log('DISCORD ON READY');
    const guilds = await this.client?.guilds.fetch();
    for (const [, guild] of guilds) {
      const fullGuild = await guild.fetch();
      await this.voiceManager.scanGuild(fullGuild);

      // Send after a brief delay
      setTimeout(async () => {
        // For each server the client is in, fire a connected event
        const fullGuild = await guild.fetch();
        logger.log('DISCORD SERVER CONNECTED', fullGuild.name);

        // Emit Discord-specific event with full guild object
        this.runtime.emitEvent([DiscordEventTypes.WORLD_CONNECTED], {
          runtime: this.runtime,
          server: fullGuild,
          source: 'discord',
        });

        // Create platform-agnostic world data structure with simplified structure
        const worldId = createUniqueUuid(this.runtime, fullGuild.id);
        const ownerId = createUniqueUuid(this.runtime, fullGuild.ownerId);

        const standardizedData = {
          name: fullGuild.name,
          runtime: this.runtime,
          rooms: await this.buildStandardizedRooms(fullGuild, worldId),
          entities: await this.buildStandardizedUsers(fullGuild),
          world: {
            id: worldId,
            name: fullGuild.name,
            agentId: this.runtime.agentId,
            serverId: fullGuild.id,
            metadata: {
              ownership: fullGuild.ownerId ? { ownerId } : undefined,
              roles: {
                [ownerId]: Role.OWNER,
              },
            },
          } as World,
          source: 'discord',
        };

        // Emit standardized event
        this.runtime.emitEvent([EventType.WORLD_CONNECTED], standardizedData);
      }, 1000);
    }

    this.client?.emit('voiceManagerReady');
  }
}

export default DiscordService;

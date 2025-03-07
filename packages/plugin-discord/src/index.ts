import {
  ChannelType,
  type Character,
  createUniqueUuid,
  type Entity,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type Plugin,
  Role,
  Service,
  type UUID,
  type World
} from "@elizaos/core";
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
  Partials,
  PermissionsBitField,
  type TextChannel,
  type User,
} from "discord.js";
import chatWithAttachments from "./actions/chatWithAttachments.ts";
import downloadMedia from "./actions/downloadMedia.ts";
import summarize from "./actions/summarizeConversation.ts";
import transcribe_media from "./actions/transcribeMedia.ts";
import joinVoice from "./actions/voiceJoin.ts";
import leaveVoice from "./actions/voiceLeave.ts";
import { DISCORD_SERVICE_NAME } from "./constants.ts";
import { MessageManager } from "./messages.ts";
import channelStateProvider from "./providers/channelState.ts";
import voiceStateProvider from "./providers/voiceState.ts";
import { DiscordTestSuite } from "./tests.ts";
import type { IDiscordService } from "./types.ts";
import { VoiceManager } from "./voice.ts";

export class DiscordService extends Service implements IDiscordService {
  static serviceType: string = DISCORD_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on discord";
  client: DiscordJsClient;
  character: Character;
  messageManager: MessageManager;
  voiceManager: VoiceManager;

  constructor(runtime: IAgentRuntime) {
    super(runtime);

    logger.log("Discord client constructor was engaged");

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
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.Reaction,
      ],
    });

    this.runtime = runtime;
    this.voiceManager = new VoiceManager(this, runtime);
    this.messageManager = new MessageManager(this);

    this.client.once(Events.ClientReady, this.onClientReady.bind(this));
    this.client.login(runtime.getSetting("DISCORD_API_TOKEN") as string);

    this.setupEventListeners();

    // give it to the
    const ensureAllServersExist = async (runtime: IAgentRuntime) => {
      const guilds = await this.client.guilds.fetch();
      for (const [, guild] of guilds) {
        await this.ensureAllChannelsExist(runtime, guild);
      }
    };

    ensureAllServersExist(this.runtime);
  }

  async ensureAllChannelsExist(runtime: IAgentRuntime, guild: OAuth2Guild) {
    // fetch the owning member from the OAuth2Guild object
    const guildObj = await guild.fetch();
    const guildChannels = await guild.fetch();
    // for channel in channels
    for (const [, channel] of guildChannels.channels.cache) {
      const roomId = createUniqueUuid(this.runtime, channel.id)
      const room = await runtime.getDatabaseAdapter().getRoom(roomId);
      // if the room already exists, skip
      if (room) {
        continue;
      }
      const worldId = createUniqueUuid(runtime, guild.id);
      const ownerId = createUniqueUuid(this.runtime, guildObj.ownerId);
      await runtime.ensureWorldExists({
        id: worldId,
        name: guild.name,
        serverId: guild.id,
        agentId: runtime.agentId,
        metadata: {
          ownership: guildObj.ownerId ? { ownerId } : undefined,
          roles: {
            [ownerId]: Role.OWNER,
          },
        },
      });
      await runtime.ensureRoomExists({
        id: roomId,
        name: channel.name,
        source: "discord",
        type: ChannelType.GROUP,
        channelId: channel.id,
        serverId: guild.id,
        worldId,
      });
    }
  }

  private setupEventListeners() {
    // When joining to a new server
    this.client.on("guildCreate", this.handleGuildCreate.bind(this));

    this.client.on(
      Events.MessageReactionAdd,
      this.handleReactionAdd.bind(this)
    );
    this.client.on(
      Events.MessageReactionRemove,
      this.handleReactionRemove.bind(this)
    );

    this.client.on(Events.GuildMemberAdd, this.handleGuildMemberAdd.bind(this));

    // Handle voice events with the voice manager
    this.client.on(
      "voiceStateUpdate",
      this.voiceManager.handleVoiceStateUpdate.bind(this.voiceManager)
    );
    this.client.on(
      "userStream",
      this.voiceManager.handleUserStream.bind(this.voiceManager)
    );

    // Handle a new message with the message manager
    this.client.on(
      Events.MessageCreate,
      this.messageManager.handleMessage.bind(this.messageManager)
    );

    // Handle a new interaction
    this.client.on(
      Events.InteractionCreate,
      this.handleInteractionCreate.bind(this)
    );
  }

  private async handleGuildMemberAdd(member: GuildMember) {
    logger.log(`New member joined: ${member.user.username}`);

    const guild = member.guild;

    const tag = member.user.bot
      ? `${member.user.username}#${member.user.discriminator}`
      : member.user.username;

    // Emit standardized USER_JOINED event
    this.runtime.emitEvent("USER_JOINED", {
      runtime: this.runtime,
      entityId: createUniqueUuid(this.runtime, member.id),
      user: {
        id: member.id,
        username: tag,
        displayName: member.displayName || member.user.username,
      },
      serverId: guild.id,
      channelId: null, // No specific channel for server joins
      channelType: ChannelType.WORLD,
      source: "discord",
    });

    this.runtime.emitEvent("DISCORD_USER_JOINED", {
      runtime: this.runtime,
      entityId: createUniqueUuid(this.runtime, member.id),
      member,
      guild,
    });
  }

  static async start(runtime: IAgentRuntime): Promise<DiscordService> {
    const client = new DiscordService(runtime);
    return client;
  }

  static async stop(runtime: IAgentRuntime) {
    const client = runtime.getService(DISCORD_SERVICE_NAME);
    if (!client) {
      logger.error("DiscordService not found");
      return;
    }
    try {
      // disconnect websocket
      // this unbinds all the listeners
      await client.stop();
    } catch (e) {
      logger.error("client-discord instance stop err", e);
    }
  }

  async stop() {
    await this.client.destroy();
  }

  private async onClientReady(readyClient: { user: { tag: any; id: any } }) {
    logger.success(`Logged in as ${readyClient.user?.tag}`);

    // Register slash commands
    const commands = [
      {
        name: "joinchannel",
        description: "Join a voice channel",
        options: [
          {
            name: "channel",
            type: 7, // CHANNEL type
            description: "The voice channel to join",
            required: true,
            channel_types: [2], // GuildVoice type
          },
        ],
      },
      {
        name: "leavechannel",
        description: "Leave the current voice channel",
      },
    ];

    try {
      await this.client.application?.commands.set(commands);
      logger.success("Slash commands registered");
    } catch (error) {
      console.error("Error registering slash commands:", error);
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

    logger.success("Use this URL to add the bot to your server:");
    logger.success(
      `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user?.id}&permissions=${requiredPermissions}&scope=bot%20applications.commands`
    );
    await this.onReady();
  }

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

  async handleReactionAdd(reaction: MessageReaction, user: User) {
    try {
      logger.log("Reaction added");

      // Early returns
      if (!reaction || !user) {
        logger.warn("Invalid reaction or user");
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
          logger.error("Failed to fetch partial reaction:", error);
          return;
        }
      }

      // Generate IDs with timestamp to ensure uniqueness
      const timestamp = Date.now();
      const roomId = createUniqueUuid(this.runtime, reaction.message.channel.id)
      const entityId = createUniqueUuid(this.runtime, user.id);
      const reactionUUID = createUniqueUuid(this.runtime, `${reaction.message.id}-${user.id}-${emoji}-${timestamp}`);

      // Validate IDs
      if (!entityId || !roomId) {
        logger.error("Invalid user ID or room ID", {
          entityId,
          roomId,
        });
        return;
      }

      // Process message content
      const messageContent = reaction.message.content || "";
      const truncatedContent =
        messageContent.length > 50
          ? `${messageContent.substring(0, 50)}...`
          : messageContent;
      const reactionMessage = `*Added <${emoji}> to: "${truncatedContent}"*`;

      // Get user info
      const userName = reaction.message.author?.username || "unknown";
      const name = reaction.message.author?.displayName || userName;

      // TODO: Get the type of the channel

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        name: name,
        source: "discord",
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
          source: "discord",
          inReplyTo,
          channelType: await this.getChannelType(reaction.message.channel as Channel),
        },
        roomId,
        createdAt: timestamp,
      };

      const callback: HandlerCallback = async (content) => {
        if (!reaction.message.channel) {
          logger.error("No channel found for reaction message");
          return;
        }
        await (reaction.message.channel as TextChannel).send(content.text);
        return [];
      };

      this.runtime.emitEvent(
        ["DISCORD_REACTION_RECEIVED", "REACTION_RECEIVED"],
        {
          runtime: this.runtime,
          message: memory,
          callback,
        }
      );
    } catch (error) {
      logger.error("Error handling reaction:", error);
    }
  }

  async handleReactionRemove(reaction: MessageReaction, user: User) {
    try {
      logger.log("Reaction removed");

      let emoji = reaction.emoji.name;
      if (!emoji && reaction.emoji.id) {
        emoji = `<:${reaction.emoji.name}:${reaction.emoji.id}>`;
      }

      // Fetch the full message if it's a partial
      if (reaction.partial) {
        try {
          await reaction.fetch();
        } catch (error) {
          logger.error(
            "Something went wrong when fetching the message:",
            error
          );
          return;
        }
      }

      const messageContent = reaction.message.content || "";
      const truncatedContent =
        messageContent.length > 50
          ? `${messageContent.substring(0, 50)}...`
          : messageContent;

      const reactionMessage = `*Removed <${emoji}> from: "${truncatedContent}"*`;

      const roomId = createUniqueUuid(this.runtime, reaction.message.channel.id)

      const entityId = createUniqueUuid(this.runtime, user.id);
      const timestamp = Date.now();
      const reactionUUID = createUniqueUuid(this.runtime, `${reaction.message.id}-${user.id}-${emoji}-${timestamp}`);

      const userName = reaction.message.author?.username || "unknown";
      const name = reaction.message.author?.displayName || userName;

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        name: name,
        source: "discord",
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
          source: "discord",
          inReplyTo: createUniqueUuid(this.runtime, reaction.message.id),
          channelType: await this.getChannelType(reaction.message.channel as Channel),
        },
        roomId,
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (content) => {
        if (!reaction.message.channel) {
          logger.error("No channel found for reaction message");
          return;
        }
        await (reaction.message.channel as TextChannel).send(content.text);
        return [];
      };

      this.runtime.emitEvent(["DISCORD_REACTION_EVENT", "REACTION_RECEIVED"], {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      logger.error("Error handling reaction removal:", error);
    }
  }

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
      source: "discord",
    };

    // Emit both Discord-specific and standardized events with the same data structure
    this.runtime.emitEvent(["DISCORD_SERVER_JOINED"], {
      runtime: this.runtime,
      server: fullGuild,
      source: "discord",
    });

    // Emit standardized event with the same structure as SERVER_CONNECTED
    this.runtime.emitEvent(["SERVER_JOINED"], standardizedData);
  }

  private async handleInteractionCreate(interaction: any) {
    if (!interaction.isCommand()) return;

    switch (interaction.commandName) {
      case "joinchannel":
        await this.voiceManager.handleJoinChannelCommand(interaction);
        break;
      case "leavechannel":
        await this.voiceManager.handleLeaveChannelCommand(interaction);
        break;
    }
  }

  /**
   * Builds a standardized list of rooms from Discord guild channels
   */
  private async buildStandardizedRooms(
    guild: Guild,
    _worldId: UUID
  ): Promise<any[]> {
    const rooms = [];

    for (const [channelId, channel] of guild.channels.cache) {
      // Only process text and voice channels
      if (
        channel.type === DiscordChannelType.GuildText ||
        channel.type === DiscordChannelType.GuildVoice
      ) {
        const roomId = createUniqueUuid(this.runtime, channelId)
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

        if (
          guild.memberCount < 1000 &&
          channel.type === DiscordChannelType.GuildText
        ) {
          try {
            // Only attempt this for smaller guilds
            // Get members with read permissions for this channel
            participants = Array.from(guild.members.cache.values())
              .filter((member) =>
                channel
                  .permissionsFor(member)
                  ?.has(PermissionsBitField.Flags.ViewChannel)
              )
              .map((member) =>
                createUniqueUuid(this.runtime, member.id)
              );
          } catch (error) {
            logger.warn(
              `Failed to get participants for channel ${channel.name}:`,
              error
            );
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
    const botId = this.client.user?.id;

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
                discord: member.user.globalName ? {
                  username: tag,
                  name: member.displayName || member.user.username,
                  globalName: member.user.globalName,
                  userId: member.id,
                } : {
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
                    discord: member.user.globalName ? {
                      username: tag,
                      name: member.displayName || member.user.username,
                      globalName: member.user.globalName,
                      userId: member.id,
                    } : {
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
                discord: member.user.globalName ? {
                  username: tag,
                  name: member.displayName || member.user.username,
                  globalName: member.user.globalName,
                  userId: member.id,
                } : {
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
    logger.log("DISCORD ON READY");
    const guilds = await this.client.guilds.fetch();
    for (const [, guild] of guilds) {
      const fullGuild = await guild.fetch();
      await this.voiceManager.scanGuild(fullGuild);

      // Send after a brief delay
      setTimeout(async () => {
        // For each server the client is in, fire a connected event
        const fullGuild = await guild.fetch();
        logger.log("DISCORD SERVER CONNECTED", fullGuild.name);

        // Emit Discord-specific event with full guild object
        this.runtime.emitEvent(["DISCORD_SERVER_CONNECTED"], {
          runtime: this.runtime,
          server: fullGuild,
          source: "discord",
        });

        // Create platform-agnostic world data structure with simplified structure
        const worldId = createUniqueUuid(this.runtime, fullGuild.id);
        const ownerId = createUniqueUuid(this.runtime, fullGuild.ownerId);

        const standardizedData = {
          name: fullGuild.name,
          runtime: this.runtime,
          rooms: await this.buildStandardizedRooms(fullGuild, worldId),
          users: await this.buildStandardizedUsers(fullGuild),
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
          source: "discord",
        };

        // Emit standardized event
        this.runtime.emitEvent(["SERVER_CONNECTED"], standardizedData);
      }, 1000);
    }

    this.client.emit("voiceManagerReady");
  }
}

const discordPlugin: Plugin = {
  name: "discord",
  description: "Discord client plugin",
  services: [DiscordService],
  actions: [
    chatWithAttachments,
    downloadMedia,
    joinVoice,
    leaveVoice,
    summarize,
    transcribe_media,
  ],
  providers: [channelStateProvider, voiceStateProvider],
  tests: [new DiscordTestSuite()],
};

export default discordPlugin;

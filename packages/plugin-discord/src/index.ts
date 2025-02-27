import {
  ChannelType,
  type Character,
  type Client as ElizaClient,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type Plugin,
  RoleName,
  stringToUuid,
  UUID,
  WorldData,
} from "@elizaos/core";
import {
  Client,
  ChannelType as DiscordChannelType,
  Events,
  GatewayIntentBits,
  type Guild,
  GuildMember,
  type MessageReaction,
  type OAuth2Guild,
  Partials,
  PermissionsBitField,
  type TextChannel,
  type User,
} from "discord.js";
import { EventEmitter } from "node:events";
import chatWithAttachments from "./actions/chatWithAttachments.ts";
import downloadMedia from "./actions/downloadMedia.ts";
import reply from "./actions/reply.ts";
import summarize from "./actions/summarizeConversation.ts";
import transcribe_media from "./actions/transcribeMedia.ts";
import joinVoice from "./actions/voiceJoin.ts";
import leaveVoice from "./actions/voiceLeave.ts";
import { DISCORD_CLIENT_NAME } from "./constants.ts";
import { MessageManager } from "./messages.ts";
import channelStateProvider from "./providers/channelState.ts";
import voiceStateProvider from "./providers/voiceState.ts";
import { DiscordTestSuite } from "./tests.ts";
import type { IDiscordClient } from "./types.ts";
import { VoiceManager } from "./voice.ts";

export class DiscordClient extends EventEmitter implements IDiscordClient {
  apiToken: string;
  client: Client;
  runtime: IAgentRuntime;
  character: Character;
  messageManager: MessageManager;
  voiceManager: VoiceManager;

  constructor(runtime: IAgentRuntime) {
    super();

    logger.log("Discord client constructor was engaged");

    this.apiToken = runtime.getSetting("DISCORD_API_TOKEN") as string;
    this.client = new Client({
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
    this.voiceManager = new VoiceManager(this);
    this.messageManager = new MessageManager(this);

    this.client.once(Events.ClientReady, this.onClientReady.bind(this));
    this.client.login(this.apiToken);

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
      const roomId = stringToUuid(`${channel.id}-${runtime.agentId}`);
      const room = await runtime.getRoom(roomId);
      // if the room already exists, skip
      if (room) {
        continue;
      }
      const worldId = stringToUuid(`${guild.id}-${runtime.agentId}`);

      const ownerId = stringToUuid(`${guildObj.ownerId}-${runtime.agentId}`);
      const tenantSpecificOwnerId = runtime.generateTenantUserId(ownerId);
      await runtime.ensureWorldExists({
        id: worldId,
        name: guild.name,
        serverId: guild.id,
        agentId: runtime.agentId,
        metadata: {
          ownership: guildObj.ownerId ? { ownerId } : undefined,
          roles: {
            [tenantSpecificOwnerId]: RoleName.OWNER,
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
      member,
      guild,
    });
  }

  async stop() {
    try {
      // disconnect websocket
      // this unbinds all the listeners
      await this.client.destroy();
    } catch (e) {
      logger.error("client-discord instance stop err", e);
    }
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

  async getChannelType(channelId: string): Promise<ChannelType> {
    const channel = await this.client.channels.fetch(channelId);
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
      const roomId = stringToUuid(
        `${reaction.message.channel.id}-${this.runtime.agentId}`
      );
      const userIdUUID = stringToUuid(`${user.id}-${this.runtime.agentId}`);
      const reactionUUID = stringToUuid(
        `${reaction.message.id}-${user.id}-${emoji}-${timestamp}-${this.runtime.agentId}`
      );

      // Validate IDs
      if (!userIdUUID || !roomId) {
        logger.error("Invalid user ID or room ID", {
          userIdUUID,
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
        userId: userIdUUID,
        roomId,
        userName,
        userScreenName: name,
        source: "discord",
        channelId: reaction.message.channel.id,
        serverId: reaction.message.guild?.id,
        type: await this.getChannelType(reaction.message.channel.id),
      });

      const memory: Memory = {
        id: reactionUUID,
        userId: userIdUUID,
        agentId: this.runtime.agentId,
        content: {
          name,
          userName,
          text: reactionMessage,
          source: "discord",
          inReplyTo: stringToUuid(
            `${reaction.message.id}-${this.runtime.agentId}`
          ),
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

      const roomId = stringToUuid(
        `${reaction.message.channel.id}-${this.runtime.agentId}`
      );
      const userIdUUID = stringToUuid(`${user.id}-${this.runtime.agentId}`);
      const reactionUUID = stringToUuid(
        `${reaction.message.id}-${user.id}-${emoji}-removed-${this.runtime.agentId}`
      );

      const userName = reaction.message.author?.username || "unknown";
      const name = reaction.message.author?.displayName || userName;

      await this.runtime.ensureConnection({
        userId: userIdUUID,
        roomId,
        userName,
        userScreenName: name,
        source: "discord",
        channelId: reaction.message.channel.id,
        serverId: reaction.message.guild?.id,
        type: await this.getChannelType(reaction.message.channel.id),
      });

      const memory: Memory = {
        id: reactionUUID,
        userId: userIdUUID,
        agentId: this.runtime.agentId,
        content: {
          name,
          userName,
          text: reactionMessage,
          source: "discord",
          inReplyTo: stringToUuid(
            `${reaction.message.id}-${this.runtime.agentId}`
          ),
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

    const ownerId = stringToUuid(
      `${fullGuild.ownerId}-${this.runtime.agentId}`
    );

    // Create standardized world data structure
    const worldId = stringToUuid(`${fullGuild.id}-${this.runtime.agentId}`);
    const tenantSpecificOwnerId = this.runtime.generateTenantUserId(ownerId);
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
          ownership: fullGuild.ownerId ? { ownerId: tenantSpecificOwnerId } : undefined,
          roles: {
            [tenantSpecificOwnerId]: RoleName.OWNER,
          },
        },
      } as WorldData,
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
    worldId: UUID
  ): Promise<any[]> {
    const rooms = [];

    for (const [channelId, channel] of guild.channels.cache) {
      // Only process text and voice channels
      if (
        channel.type === DiscordChannelType.GuildText ||
        channel.type === DiscordChannelType.GuildVoice
      ) {
        const roomId = stringToUuid(`${channelId}-${this.runtime.agentId}`);
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
                stringToUuid(`${member.id}-${this.runtime.agentId}`)
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
  private async buildStandardizedUsers(guild: Guild): Promise<any[]> {
    const users = [];
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
            users.push({
              id: stringToUuid(`${member.id}-${this.runtime.agentId}`),
              names: Array.from(
                new Set([member.user.username, member.displayName])
              ),
              metadata: {
                default: {
                  username: tag,
                  name: member.displayName || member.user.username,
                },
                discord: {
                  username: tag,
                  displayName: member.displayName || member.user.username,
                },
              },
            });
          }
        }

        // If cache has very few members, try to get online members
        if (users.length < 100) {
          logger.info(`Adding online members for ${guild.name}`);
          // This is a more targeted fetch that is less likely to hit rate limits
          const onlineMembers = await guild.members.fetch({ limit: 100 });

          for (const [, member] of onlineMembers) {
            if (member.id !== botId) {
              const userId = stringToUuid(
                `${member.id}-${this.runtime.agentId}`
              );
              // Avoid duplicates
              if (!users.some((u) => u.id === userId)) {
                const tag = member.user.bot
                  ? `${member.user.username}#${member.user.discriminator}`
                  : member.user.username;

                users.push({
                  id: userId,
                  names: Array.from(
                    new Set([member.user.username, member.displayName])
                  ),
                  metadata: {
                    discord: {
                      username: tag,
                      displayName: member.displayName || member.user.username,
                    },
                    default: {
                      username: tag,
                      name: member.displayName || member.user.username,
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

            users.push({
              id: stringToUuid(`${member.id}-${this.runtime.agentId}`),
              names: Array.from(
                new Set([member.user.username, member.displayName])
              ),
              metadata: {
                default: {
                  username: tag,
                  name: member.displayName || member.user.username,
                },
                discord: {
                  username: tag,
                  displayName: member.displayName || member.user.username,
                },
              },
            });
          }
        }
      } catch (error) {
        logger.error(`Error fetching members for ${guild.name}:`, error);
      }
    }

    return users;
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
        logger.log("DISCORD SERVER CONNECTED", fullGuild);

        // Emit Discord-specific event with full guild object
        this.runtime.emitEvent(["DISCORD_SERVER_CONNECTED"], {
          runtime: this.runtime,
          server: fullGuild,
          source: "discord",
        });

        // Create platform-agnostic world data structure with simplified structure
        const worldId = stringToUuid(`${fullGuild.id}-${this.runtime.agentId}`);

        const ownerId = stringToUuid(
          `${fullGuild.ownerId}-${this.runtime.agentId}`
        );
        const tenantSpecificOwnerId = this.runtime.generateTenantUserId(ownerId);

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
              ownership: fullGuild.ownerId ? { ownerId } : undefined,
              roles: {
                [tenantSpecificOwnerId]: RoleName.OWNER,
              },
            },
          } as WorldData,
          source: "discord",
        };

        // Emit standardized event
        this.runtime.emitEvent(["SERVER_CONNECTED"], standardizedData);
      }, 1000);
    }

    this.client.emit("voiceManagerReady");
  }
}

const DiscordClientInterface: ElizaClient = {
  name: DISCORD_CLIENT_NAME,
  start: async (runtime: IAgentRuntime) => new DiscordClient(runtime),
};

const discordPlugin: Plugin = {
  name: "discord",
  description: "Discord client plugin",
  clients: [DiscordClientInterface],
  actions: [
    reply,
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

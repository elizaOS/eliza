import {
  ChannelType,
  type Character,
  type Content,
  type CustomMetadata,
  createUniqueUuid,
  type Entity,
  type EventPayload,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  MemoryType,
  Role,
  type Room,
  Service,
  stringToUuid,
  type TargetInfo,
  type UUID,
  type World,
} from "@elizaos/core";

/**
 * IMPORTANT: Discord ID Handling - Why stringToUuid() instead of asUUID()
 *
 * Discord uses "snowflake" IDs - large 64-bit integers represented as strings
 * (e.g., "1253563208833433701"). These are NOT valid UUIDs.
 *
 * UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (8-4-4-4-12 hex digits with dashes)
 * Discord ID:  1253563208833433701 (plain number string)
 *
 * The two UUID-related functions behave differently:
 *
 * - `asUUID(str)` - VALIDATES that the string is already a valid UUID format.
 *   If not, it throws: "Error: Invalid UUID format: 1253563208833433701"
 *   Use only when you're certain the input is already a valid UUID.
 *
 * - `stringToUuid(str)` - CONVERTS any string into a deterministic UUID by hashing it.
 *   Always succeeds. The same input always produces the same UUID output.
 *   Use this for Discord snowflake IDs.
 *
 * When working with Discord IDs in ElizaOS:
 *
 * 1. `stringToUuid(discordId)` - For storing Discord IDs in UUID fields (e.g., `messageServerId`).
 *
 * 2. `createUniqueUuid(runtime, discordId)` - For `worldId` and `roomId`. This adds the agent's
 *    ID to the hash, ensuring each agent has its own unique namespace for the same Discord server.
 *
 * 3. `messageServerId` - The correct property name for server IDs on Room and World objects.
 *
 * 4. Discord-specific events (e.g., DiscordEventTypes.VOICE_STATE_UPDATE) are not in core's
 *    EventPayloadMap. When emitting these events, cast to `string[]` and payload to `any`
 *    to use the generic emitEvent overload.
 */
import {
  type ApplicationCommandData,
  type ApplicationCommandDataResolvable,
  AttachmentBuilder,
  AuditLogEvent,
  type Channel,
  type ChatInputApplicationCommandData,
  type Collection,
  ChannelType as DiscordChannelType,
  Client as DiscordJsClient,
  type Role as DiscordRole,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  Partials,
  type PartialUser,
  PermissionsBitField,
  type TextChannel,
  type User,
} from "discord.js";
import { createCompatRuntime, type ICompatRuntime, type WorldCompat } from "./compat";
import { DISCORD_SERVICE_NAME } from "./constants";
import { getDiscordSettings } from "./environment";
import { MessageManager } from "./messages";
import {
  diffMemberRoles,
  diffOverwrites,
  diffRolePermissions,
  fetchAuditEntry,
} from "./permissionEvents";
import { generateInviteUrl } from "./permissions";
import {
  type ChannelHistoryOptions,
  type ChannelHistoryResult,
  type ChannelSpiderState,
  DiscordEventTypes,
  type DiscordListenChannelPayload,
  type DiscordNotInChannelsPayload,
  type DiscordReactionPayload,
  type DiscordRegisterCommandsPayload,
  type DiscordSettings,
  type DiscordSlashCommand,
  type DiscordSlashCommandPayload,
  type IDiscordService,
} from "./types";
import { getAttachmentFileName, MAX_MESSAGE_LENGTH, splitMessage } from "./utils";
import { VoiceManager } from "./voice";

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
  // Override runtime type for messageServerId cross-core compatibility (see compat.ts)
  protected declare runtime: ICompatRuntime;

  static serviceType: string = DISCORD_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on discord";
  client: DiscordJsClient | null;
  character: Character;
  messageManager?: MessageManager;
  voiceManager?: VoiceManager;
  private discordSettings: DiscordSettings;
  private userSelections: Map<string, Record<string, unknown>> = new Map();
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  public clientReadyPromise: Promise<void> | null = null;
  private slashCommands: DiscordSlashCommand[] = [];
  private commandRegistrationQueue: Promise<void> = Promise.resolve();
  /**
   * Slash command names that should bypass allowed channel restrictions.
   */
  private allowAllSlashCommands: Set<string> = new Set();
  /**
   * List of allowed channel IDs (parsed from CHANNEL_IDS env var).
   * If undefined, all channels are allowed.
   */
  private allowedChannelIds?: string[];

  /**
   * Set of dynamically added channel IDs through joinChannel action.
   * These are merged with allowedChannelIds for runtime channel management.
   */
  private dynamicChannelIds: Set<string> = new Set();

  /**
   * Constructor for Discord client.
   * Initializes the Discord client with specified intents and partials,
   * sets up event listeners, and ensures all servers exist.
   *
   * @param {IAgentRuntime} runtime - The AgentRuntime instance
   */
  constructor(runtime: IAgentRuntime) {
    super(runtime);

    // Load Discord settings with proper priority (env vars > character settings > defaults)
    this.discordSettings = getDiscordSettings(runtime);

    this.character = runtime.character;

    // Parse CHANNEL_IDS env var to restrict the bot to specific channels
    const channelIdsRaw = runtime.getSetting("CHANNEL_IDS") as string | undefined;
    if (
      channelIdsRaw &&
      typeof channelIdsRaw === "string" &&
      channelIdsRaw.trim &&
      typeof channelIdsRaw.trim === "function" &&
      channelIdsRaw.trim()
    ) {
      this.allowedChannelIds = channelIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          allowedChannelIds: this.allowedChannelIds,
        },
        "Channel restrictions enabled"
      );
    }

    // Check if Discord API token is available and valid
    const token = runtime.getSetting("DISCORD_API_TOKEN") as string;
    const tokenTrimmed =
      token && typeof token === "string" && token.trim && typeof token.trim === "function"
        ? token.trim()
        : token;
    if (!token || tokenTrimmed === "" || token === null) {
      this.runtime.logger.warn("Discord API Token not provided");
      this.client = null;
      return;
    }

    try {
      const client = new DiscordJsClient({
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
      this.client = client;

      this.runtime = createCompatRuntime(runtime);
      this.voiceManager = new VoiceManager(this, this.runtime);
      this.messageManager = new MessageManager(this, this.runtime);

      this.clientReadyPromise = new Promise((resolve, reject) => {
        // once logged in
        client.once(Events.ClientReady, async (readyClient) => {
          try {
            await this.onReady(readyClient);
            resolve();
          } catch (error) {
            this.runtime.logger.error(
              `Error in onReady: ${error instanceof Error ? error.message : String(error)}`
            );
            reject(error);
          }
        });
        // Handle client errors that might prevent ready event
        client.once(Events.Error, (error) => {
          this.runtime.logger.error(
            `Discord client error: ${error instanceof Error ? error.message : String(error)}`
          );
          reject(error);
        });
        // now start login
        client.login(token).catch((error) => {
          this.runtime.logger.error(
            `Failed to login to Discord: ${error instanceof Error ? error.message : String(error)}`
          );
          if (this.client) {
            this.client.destroy().catch(() => {});
          }
          this.client = null;
          reject(error);
        });
      });

      // Attach error handler to prevent unhandled promise rejection
      // This ensures the promise rejection is handled even if no one awaits it immediately
      this.clientReadyPromise.catch((_error) => {
        // Error is already logged in the promise handlers above
        // This catch prevents unhandled promise rejection warnings
        // The promise is public and may be awaited elsewhere, but we need to handle
        // the case where it's not immediately awaited
      });

      this.setupEventListeners();
      // Send handler registered via runtime.registerSendHandlers()
    } catch (error) {
      runtime.logger.error(
        `Error initializing Discord client: ${error instanceof Error ? error.message : String(error)}`
      );
      this.client = null;
    }
  }

  static async start(runtime: IAgentRuntime) {
    const service = new DiscordService(runtime);
    return service;
  }

  /**
   * The SendHandlerFunction implementation for Discord.
   * @param {IAgentRuntime} runtime - The runtime instance.
   * @param {TargetInfo} target - The target information for the message.
   * @param {Content} content - The content of the message to send.
   * @returns {Promise<void>} A promise that resolves when the message is sent or rejects on error.
   * @throws {Error} If the client is not ready, target is invalid, or sending fails.
   */
  async handleSendMessage(
    // why we have this.runtime on the agent itself and this isn't a static
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    if (!this.client || !this.client.isReady()) {
      runtime.logger.error("Client not ready");
      throw new Error("Discord client is not ready.");
    }
    // After the check above, client is guaranteed to exist and be ready
    const client = this.client;

    // Skip sending if channel restrictions are set and target channel is not allowed
    if (target.channelId && this.allowedChannelIds && !this.isChannelAllowed(target.channelId)) {
      runtime.logger.warn(`Channel ${target.channelId} not in allowed list, skipping send`);
      return;
    }

    let targetChannel: Channel | undefined | null = null;

    try {
      // Determine target based on provided info
      if (target.channelId) {
        targetChannel = await client.channels.fetch(target.channelId);
      } else if (target.entityId) {
        // Attempt to convert runtime UUID to Discord snowflake ID
        // NOTE: This assumes a mapping exists or the UUID *is* the snowflake ID
        const discordUserId = target.entityId as string; // May need more robust conversion
        const user = await client.users.fetch(discordUserId);
        if (user) {
          // user.dmChannel is a property (DMChannel | null), not a promise
          targetChannel = user.dmChannel ?? (await user.createDM());
        }
      } else {
        throw new Error("Discord SendHandler requires channelId or entityId.");
      }

      if (!targetChannel) {
        // Safely serialize target for error message (target only contains strings, but be defensive)
        const targetStr = JSON.stringify(target, (_key, value) => {
          // Convert BigInt to string if somehow present
          if (typeof value === "bigint") {
            return value.toString();
          }
          return value;
        });
        throw new Error(`Could not find target Discord channel/DM for target: ${targetStr}`);
      }

      // Type guard to ensure the channel is text-based
      if (targetChannel.isTextBased() && !targetChannel.isVoiceBased()) {
        // Further check if it's a channel where bots can send messages
        if ("send" in targetChannel && typeof targetChannel.send === "function") {
          // Convert Media attachments to Discord AttachmentBuilder format
          const files: AttachmentBuilder[] = [];
          if (content.attachments && content.attachments.length > 0) {
            for (const media of content.attachments) {
              if (media.url) {
                const fileName = getAttachmentFileName(media);
                files.push(new AttachmentBuilder(media.url, { name: fileName }));
              }
            }
          }

          const sentMessages: Message[] = [];
          const roomId = createUniqueUuid(runtime, targetChannel.id);
          const channelType = await this.getChannelType(targetChannel as Channel);

          // Send message with text and/or attachments
          if (content.text || files.length > 0) {
            if (content.text) {
              // Split message if longer than Discord limit (uses safe buffer)
              const chunks = splitMessage(content.text, MAX_MESSAGE_LENGTH);
              if (chunks.length > 1) {
                // Send all chunks except the last one without files
                for (let i = 0; i < chunks.length - 1; i++) {
                  const sent = await targetChannel.send(chunks[i]);
                  sentMessages.push(sent);
                }
                // Send the last chunk with files (if any)
                const sent = await targetChannel.send({
                  content: chunks[chunks.length - 1],
                  files: files.length > 0 ? files : undefined,
                });
                sentMessages.push(sent);
              } else {
                // Single chunk - send with files (if any)
                const sent = await targetChannel.send({
                  content: chunks[0],
                  files: files.length > 0 ? files : undefined,
                });
                sentMessages.push(sent);
              }
            } else {
              // Only attachments, no text
              const sent = await targetChannel.send({
                files,
              });
              sentMessages.push(sent);
            }
          } else {
            runtime.logger.warn("No text content or attachments provided");
          }

          // Ensure room/world/participant exist before saving to memory (FK constraints)
          const targetChannelGuild = "guild" in targetChannel ? targetChannel.guild : null;
          const serverId = targetChannelGuild?.id ? targetChannelGuild.id : targetChannel.id;
          const worldId = createUniqueUuid(runtime, serverId) as UUID;
          const worldName = targetChannelGuild?.name ? targetChannelGuild.name : undefined;

          const clientUser = client.user;
          await this.runtime.ensureConnection({
            entityId: runtime.agentId,
            roomId,
            userName: clientUser?.username ? clientUser.username : undefined,
            name: clientUser?.displayName || clientUser?.username || undefined,
            source: "discord",
            channelId: targetChannel.id,
            messageServerId: stringToUuid(serverId),
            type: channelType,
            worldId,
            worldName,
          });

          // Save sent messages to memory
          for (const sentMsg of sentMessages) {
            try {
              // Only include attachments/actions in memory for messages that actually have attachments
              const hasAttachments = sentMsg.attachments.size > 0;

              const memory: Memory = {
                id: createUniqueUuid(runtime, sentMsg.id),
                entityId: runtime.agentId,
                agentId: runtime.agentId,
                roomId,
                content: {
                  text: sentMsg.content || content.text || " ",
                  url: sentMsg.url,
                  channelType,
                  // Only include attachments for messages that actually have attachments
                  ...(hasAttachments && content.attachments
                    ? { attachments: content.attachments }
                    : {}),
                  // Include action whenever it exists, regardless of attachments
                  ...(content.action ? { action: content.action } : {}),
                },
                metadata: {
                  type: MemoryType.MESSAGE,
                },
                createdAt: sentMsg.createdTimestamp || Date.now(),
              };

              await runtime.createMemory(memory, "messages");
              runtime.logger.debug(
                {
                  src: "plugin:discord",
                  agentId: runtime.agentId,
                  messageId: sentMsg.id,
                },
                "Saved sent message to memory"
              );
            } catch (error) {
              runtime.logger.warn(
                `Failed to save sent message ${sentMsg.id} to memory: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } else {
          throw new Error(`Target channel ${targetChannel.id} does not have a send method.`);
        }
      } else {
        throw new Error(
          `Target channel ${targetChannel.id} is not a valid text-based channel for sending messages.`
        );
      }
    } catch (error) {
      runtime.logger.error(
        `Error sending message to ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Set up event listeners for the client.
   * @private
   */
  private setupEventListeners() {
    if (!this.client) {
      return; // Skip if client is not available
    }

    const listenCidsRaw = this.runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS") as
      | string
      | string[]
      | undefined;
    const listenCids = Array.isArray(listenCidsRaw)
      ? listenCidsRaw
      : listenCidsRaw && typeof listenCidsRaw === "string" && listenCidsRaw.trim()
        ? listenCidsRaw
            .trim()
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

    // Setup handling for direct messages
    this.client.on("messageCreate", async (message) => {
      // Skip if we're sending the message or in deleted state
      const clientUser = this.client?.user;
      if (
        (clientUser && message.author.id === clientUser.id) ||
        (message.author.bot && this.discordSettings.shouldIgnoreBotMessages)
      ) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            authorId: message.author.id,
            isBot: message.author.bot,
          },
          "Ignoring message from bot or self"
        );
        return;
      }

      if (listenCids.includes(message.channel.id) && message) {
        // Use the reusable buildMemoryFromMessage method
        const newMessage = await this.buildMemoryFromMessage(message);

        if (!newMessage) {
          this.runtime.logger.warn(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              messageId: message.id,
            },
            "Failed to build memory from listen channel message"
          );
          return;
        }

        // Emit event for listen channel handlers
        const listenPayload: DiscordListenChannelPayload = {
          runtime: this.runtime,
          message: newMessage,
          source: "discord",
        };
        this.runtime.emitEvent(DiscordEventTypes.LISTEN_CHANNEL_MESSAGE, listenPayload);
      }

      // Skip if channel restrictions are set and this channel is not allowed
      if (this.allowedChannelIds && !this.isChannelAllowed(message.channel.id)) {
        // check first whether the channel is a thread...
        const channel = this.client ? await this.client.channels.fetch(message.channel.id) : null;

        const notInChannelsPayload: DiscordNotInChannelsPayload = {
          runtime: this.runtime,
          message: message,
          source: "discord",
        };
        this.runtime.emitEvent(DiscordEventTypes.NOT_IN_CHANNELS_MESSAGE, notInChannelsPayload);

        if (!channel) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              channelId: message.channel.id,
            },
            "Channel not found"
          );
          return;
        }
        if (channel.isThread()) {
          if (!channel.parentId || !this.isChannelAllowed(channel.parentId)) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                parentChannelId: channel.parentId,
              },
              "Thread not in allowed channel"
            );
            return;
          }
        } else {
          if (
            channel?.isTextBased &&
            typeof channel.isTextBased === "function" &&
            channel.isTextBased()
          ) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                channelId: channel.id,
              },
              "Channel not allowed"
            );
          }
          return;
        }
      }

      try {
        // Ensure messageManager exists
        if (this.messageManager) {
          this.messageManager.handleMessage(message);
        }
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling message"
        );
      }
    });

    // Setup handling for reactions
    this.client.on("messageReactionAdd", async (reaction, user) => {
      const clientUser = this.client?.user;
      if (clientUser && user.id === clientUser.id) {
        return;
      }
      // Skip if channel restrictions are set and this reaction is not in an allowed channel
      if (
        this.allowedChannelIds &&
        reaction.message.channel &&
        !this.isChannelAllowed(reaction.message.channel.id)
      ) {
        return;
      }
      try {
        await this.handleReactionAdd(reaction, user);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling reaction add"
        );
      }
    });

    // Handle reaction removal
    this.client.on("messageReactionRemove", async (reaction, user) => {
      const clientUser = this.client?.user;
      if (clientUser && user.id === clientUser.id) {
        return;
      }
      // Skip if channel restrictions are set and this reaction is not in an allowed channel
      if (
        this.allowedChannelIds &&
        reaction.message.channel &&
        !this.isChannelAllowed(reaction.message.channel.id)
      ) {
        return;
      }
      try {
        await this.handleReactionRemove(reaction, user);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling reaction remove"
        );
      }
    });

    // Setup guild (server) event handlers
    this.client.on("guildCreate", async (guild) => {
      try {
        await this.handleGuildCreate(guild);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling guild create"
        );
      }
    });

    // Setup member (user) joining handlers
    this.client.on("guildMemberAdd", async (member) => {
      try {
        await this.handleGuildMemberAdd(member);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling guild member add"
        );
      }
    });

    // Interaction handlers
    //
    // Permission Check Flow for Slash Commands:
    // 1. Discord native checks (before this event fires):
    //    - User has required permissions (default_member_permissions)
    //    - Command is available in this context (guild vs DM)
    // 2. ElizaOS channel whitelist (here):
    //    - If CHANNEL_IDS is set, check if channel is allowed
    //    - Unless command has bypassChannelWhitelist flag
    // 3. Custom validator (here):
    //    - Run command's validator function if provided
    //    - Full programmatic control for complex logic
    //
    // Why this order?
    // - Discord's checks are free (handled before interaction fires)
    // - Channel whitelist is cheap (Set lookup)
    // - Custom validators can be expensive (async, database calls, etc.)
    this.client.on("interactionCreate", async (interaction) => {
      const isSlashCommand = interaction.isCommand();
      const isModalSubmit = interaction.isModalSubmit();
      const isComponent = interaction.isMessageComponent();

      // Check if this slash command has bypass enabled
      const bypassChannelRestriction =
        isSlashCommand && this.allowAllSlashCommands.has(interaction.commandName ?? "");

      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          interactionType: interaction.type,
          commandName: isSlashCommand ? interaction.commandName : undefined,
          channelId: interaction.channelId,
          inGuild: interaction.inGuild(),
          bypassChannelRestriction,
        },
        "[DiscordService] interactionCreate received"
      );

      // ElizaOS Channel Whitelist Check
      // Follow-up interactions (modals, buttons, autocomplete) always bypass the channel whitelist
      // since they are responses to commands initiated by the user.
      // Slash commands respect the whitelist unless bypassChannelWhitelist: true.
      const isFollowUpInteraction = Boolean(
        interaction.isModalSubmit() ||
          interaction.isMessageComponent() ||
          interaction.isAutocomplete()
      );

      // Skip if channel restrictions are set and this interaction is not in an allowed channel
      // - Follow-up interactions (modals, components, autocomplete) always bypass
      // - Slash commands respect whitelist unless they have bypassChannelWhitelist: true
      if (
        !isFollowUpInteraction &&
        this.allowedChannelIds &&
        interaction.channelId &&
        !this.isChannelAllowed(interaction.channelId) &&
        !bypassChannelRestriction
      ) {
        // For slash commands, send a response to avoid Discord's "application did not respond" error
        // Other interaction types (non-slash) can fail silently
        if (isSlashCommand && interaction.isCommand()) {
          try {
            await interaction.reply({
              content: "This command is not available in this channel.",
              ephemeral: true,
            });
          } catch (responseError) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                error:
                  responseError instanceof Error ? responseError.message : String(responseError),
              },
              "Could not send channel restriction response"
            );
          }
        }
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelId: interaction.channelId,
            allowedChannelIds: this.allowedChannelIds,
            isSlashCommand,
            isModalSubmit,
            isComponent,
            bypassChannelRestriction,
          },
          "[DiscordService] interactionCreate ignored (channel not allowed)"
        );
        return;
      }

      // Run custom validator if provided for slash commands
      // This is the final permission check layer, after Discord's native checks
      // and our channel whitelist checks have already passed.
      //
      // Why validators?
      // - ElizaOS-specific permission systems (when implemented)
      // - Complex business logic (rate limiting, feature flags, etc.)
      // - Dynamic permissions based on runtime state
      // - Anything that can't be expressed via Discord's native permissions
      if (isSlashCommand && interaction.commandName) {
        const command = this.slashCommands.find((cmd) => cmd.name === interaction.commandName);
        if (command?.validator) {
          try {
            const isValid = await command.validator(interaction, this.runtime);
            if (!isValid) {
              // Send default response if validator didn't respond
              // This prevents Discord from showing "Interaction failed" after 3 seconds
              // or leaving a "thinking" indicator if the validator called deferReply()
              if (!interaction.replied) {
                try {
                  const errorMessage = "You do not have permission to use this command.";
                  if (interaction.deferred) {
                    // Validator called deferReply() - use editReply() to resolve the deferred state
                    await interaction.editReply({ content: errorMessage });
                  } else {
                    await interaction.reply({
                      content: errorMessage,
                      ephemeral: true,
                    });
                  }
                } catch (responseError) {
                  // Validator may have already responded or interaction expired
                  this.runtime.logger.debug(
                    {
                      src: "plugin:discord",
                      agentId: this.runtime.agentId,
                      commandName: interaction.commandName,
                      error:
                        responseError instanceof Error
                          ? responseError.message
                          : String(responseError),
                    },
                    "Could not send validator rejection response (may have already responded)"
                  );
                }
              }
              this.runtime.logger.debug(
                {
                  src: "plugin:discord",
                  agentId: this.runtime.agentId,
                  commandName: interaction.commandName,
                },
                "[DiscordService] interactionCreate ignored (custom validator returned false)"
              );
              return;
            }
          } catch (error) {
            // Send error response if validator threw and didn't respond
            // or left a "thinking" indicator via deferReply()
            if (!interaction.replied) {
              try {
                const errorMessage = "An error occurred while validating this command.";
                if (interaction.deferred) {
                  // Validator called deferReply() - use editReply() to resolve the deferred state
                  await interaction.editReply({ content: errorMessage });
                } else {
                  await interaction.reply({
                    content: errorMessage,
                    ephemeral: true,
                  });
                }
              } catch (responseError) {
                // Validator may have already responded or interaction expired
                this.runtime.logger.debug(
                  {
                    src: "plugin:discord",
                    agentId: this.runtime.agentId,
                    commandName: interaction.commandName,
                    error:
                      responseError instanceof Error
                        ? responseError.message
                        : String(responseError),
                  },
                  "Could not send validator error response (may have already responded)"
                );
              }
            }
            this.runtime.logger.error(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                commandName: interaction.commandName,
                error: error instanceof Error ? error.message : String(error),
              },
              "[DiscordService] Custom validator threw error"
            );
            return;
          }
        }
      }

      try {
        await this.handleInteractionCreate(interaction);
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling interaction"
        );
      }
    });

    this.client.on("userStream", (entityId, name, userName, channel, opusDecoder) => {
      const clientUser = this.client?.user;
      if (clientUser && entityId !== clientUser.id) {
        // Ensure voiceManager exists
        if (this.voiceManager) {
          this.voiceManager.handleUserStream(entityId, name, userName, channel, opusDecoder);
        }
      }
    });

    // =========================================================================
    // Permission Audit Events (controlled by DISCORD_AUDIT_LOG_ENABLED setting)
    // =========================================================================
    const auditLogSetting = this.runtime.getSetting("DISCORD_AUDIT_LOG_ENABLED");
    const isAuditLogEnabled = auditLogSetting !== "false" && auditLogSetting !== false;

    if (isAuditLogEnabled) {
      // Channel permission overwrites changed
      this.client.on("channelUpdate", async (oldChannel, newChannel) => {
        try {
          // Handle partials
          let channel = newChannel;
          if (channel.partial) {
            channel = await channel.fetch();
          }

          // Only process guild channels with permission overwrites
          if (!("permissionOverwrites" in oldChannel) || !("guild" in channel)) {
            return;
          }

          const guildChannel = channel as GuildChannel;
          const oldGuildChannel = oldChannel as GuildChannel;
          const oldOverwrites = oldGuildChannel.permissionOverwrites.cache;
          const newOverwrites = guildChannel.permissionOverwrites.cache;

          // Check all overwrites (old and new) to catch deletions
          const allIds = new Set([...oldOverwrites.keys(), ...newOverwrites.keys()]);

          for (const id of allIds) {
            const oldOw = oldOverwrites.get(id);
            const newOw = newOverwrites.get(id);
            const { changes, action } = diffOverwrites(oldOw, newOw);

            if (changes.length === 0) {
              continue;
            }

            // Determine audit log action type
            const auditAction =
              action === "DELETE"
                ? AuditLogEvent.ChannelOverwriteDelete
                : action === "CREATE"
                  ? AuditLogEvent.ChannelOverwriteCreate
                  : AuditLogEvent.ChannelOverwriteUpdate;

            const audit = await fetchAuditEntry(
              guildChannel.guild,
              auditAction,
              guildChannel.id,
              this.runtime
            );

            // Skip if bot made this change
            const clientUser = this.client?.user;
            if (audit?.executorId && clientUser && audit.executorId === clientUser.id) {
              continue;
            }

            // Determine target info
            const oldOwType = oldOw && oldOw.type !== undefined ? oldOw.type : null;
            const newOwType = newOw && newOw.type !== undefined ? newOw.type : null;
            const targetType = (oldOwType ?? newOwType ?? 1) === 0 ? "role" : "user";
            let targetName: string;
            if (targetType === "role") {
              const role = guildChannel.guild.roles.cache.get(id);
              targetName = role?.name ?? "Unknown";
            } else {
              const user = this.client ? await this.client.users.fetch(id).catch(() => null) : null;
              targetName = user?.tag ?? "Unknown";
            }

            this.runtime.emitEvent(DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED, {
              runtime: this.runtime,
              source: "discord",
              guild: {
                id: guildChannel.guild.id,
                name: guildChannel.guild.name,
              },
              channel: { id: guildChannel.id, name: guildChannel.name },
              target: { type: targetType, id, name: targetName },
              action,
              changes,
              audit,
            } as EventPayload);
          }
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error in channelUpdate handler"
          );
        }
      });

      // Role permission changes
      this.client.on("roleUpdate", async (oldRole, newRole) => {
        try {
          const changes = diffRolePermissions(oldRole, newRole);
          if (changes.length === 0) {
            return;
          }

          const audit = await fetchAuditEntry(
            newRole.guild,
            AuditLogEvent.RoleUpdate,
            newRole.id,
            this.runtime
          );

          // Skip if bot made this change
          const clientUser = this.client?.user;
          if (audit?.executorId && clientUser && audit.executorId === clientUser.id) {
            return;
          }

          this.runtime.emitEvent(DiscordEventTypes.ROLE_PERMISSIONS_CHANGED, {
            runtime: this.runtime,
            source: "discord",
            guild: { id: newRole.guild.id, name: newRole.guild.name },
            role: { id: newRole.id, name: newRole.name },
            changes,
            audit,
          } as EventPayload);
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error in roleUpdate handler"
          );
        }
      });

      // Member role changes
      this.client.on("guildMemberUpdate", async (oldMember, newMember) => {
        try {
          // oldMember can be partial, need to fetch if so
          if (!oldMember) {
            return;
          }

          // Fetch full member if partial
          let fullOldMember = oldMember;
          if (oldMember.partial) {
            try {
              fullOldMember = await oldMember.fetch();
            } catch {
              return; // Can't compare without full member data
            }
          }

          const { added, removed } = diffMemberRoles(fullOldMember as GuildMember, newMember);
          if (added.length === 0 && removed.length === 0) {
            return;
          }

          const audit = await fetchAuditEntry(
            newMember.guild,
            AuditLogEvent.MemberRoleUpdate,
            newMember.id,
            this.runtime
          );

          // Skip if bot made this change
          const clientUser = this.client?.user;
          if (audit?.executorId && clientUser && audit.executorId === clientUser.id) {
            return;
          }

          this.runtime.emitEvent(DiscordEventTypes.MEMBER_ROLES_CHANGED, {
            runtime: this.runtime,
            source: "discord",
            guild: { id: newMember.guild.id, name: newMember.guild.name },
            member: { id: newMember.id, tag: newMember.user.tag },
            added: added.map((r: DiscordRole) => ({
              id: r.id,
              name: r.name,
              permissions: r.permissions.toArray(),
            })),
            removed: removed.map((r: DiscordRole) => ({
              id: r.id,
              name: r.name,
              permissions: r.permissions.toArray(),
            })),
            audit,
          } as EventPayload);
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error in guildMemberUpdate handler"
          );
        }
      });

      // Role creation
      this.client.on("roleCreate", async (role) => {
        try {
          const audit = await fetchAuditEntry(
            role.guild,
            AuditLogEvent.RoleCreate,
            role.id,
            this.runtime
          );

          // Skip if bot made this change
          const clientUser = this.client?.user;
          if (audit?.executorId && clientUser && audit.executorId === clientUser.id) {
            return;
          }

          this.runtime.emitEvent(DiscordEventTypes.ROLE_CREATED, {
            runtime: this.runtime,
            source: "discord",
            guild: { id: role.guild.id, name: role.guild.name },
            role: {
              id: role.id,
              name: role.name,
              permissions: role.permissions.toArray(),
            },
            audit,
          } as EventPayload);
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error in roleCreate handler"
          );
        }
      });

      // Role deletion
      this.client.on("roleDelete", async (role) => {
        try {
          const audit = await fetchAuditEntry(
            role.guild,
            AuditLogEvent.RoleDelete,
            role.id,
            this.runtime
          );

          // Skip if bot made this change
          const clientUser = this.client?.user;
          if (audit?.executorId && clientUser && audit.executorId === clientUser.id) {
            return;
          }

          this.runtime.emitEvent(DiscordEventTypes.ROLE_DELETED, {
            runtime: this.runtime,
            source: "discord",
            guild: { id: role.guild.id, name: role.guild.name },
            role: {
              id: role.id,
              name: role.name,
              permissions: role.permissions.toArray(),
            },
            audit,
          } as EventPayload);
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Error in roleDelete handler"
          );
        }
      });
    } // end if (isAuditLogEnabled)
  }

  /**
   * Handles the event when a new member joins a guild.
   *
   * **Event Design Note:**
   * We intentionally do NOT emit the standardized `EventType.ENTITY_JOINED` here.
   * In ElizaOS's abstraction model:
   * - A Discord "guild" maps to a "world" (the server/community)
   * - A Discord "channel" maps to a "room" (a specific conversation space)
   *
   * `EventType.ENTITY_JOINED` requires a `roomId` because the bootstrap plugin's
   * handler calls `syncSingleUser()` to sync the entity to a specific room. When
   * a member joins a guild, they've joined the "world" but haven't joined any
   * specific "room" yet - they're just a potential participant.
   *
   * The entity will be properly synced to rooms when they first interact:
   * - First message in a channel → message handler calls `ensureConnection()`
   * - Joining a voice channel → voice handler syncs them to that room
   *
   * We still emit the Discord-specific `DiscordEventTypes.ENTITY_JOINED` so that
   * Discord-aware plugins can react to guild member joins (e.g., welcome messages,
   * role assignment, moderation checks).
   *
   * @param {GuildMember} member - The GuildMember object representing the new member.
   * @returns {Promise<void>} - A Promise that resolves once the event handling is complete.
   * @private
   */
  private async handleGuildMemberAdd(member: GuildMember) {
    this.runtime.logger.info(`New member joined: ${member.user.username} (${member.id})`);

    const guild = member.guild;

    const tag = member.user.bot
      ? `${member.user.username}#${member.user.discriminator}`
      : member.user.username;

    const worldId = createUniqueUuid(this.runtime, guild.id);
    const entityId = createUniqueUuid(this.runtime, member.id);

    // Emit Discord-specific event for plugins that want to handle guild member joins.
    // This is NOT the standardized EventType.ENTITY_JOINED because:
    // 1. ENTITY_JOINED requires a roomId (which channel did they join?)
    // 2. Guild membership != room membership; users join rooms when they interact
    // 3. The bootstrap handler would fail without roomId anyway
    // Discord-aware plugins can listen to DiscordEventTypes.ENTITY_JOINED instead.
    this.runtime.emitEvent([DiscordEventTypes.ENTITY_JOINED], {
      runtime: this.runtime,
      entityId,
      worldId,
      source: "discord",
      metadata: {
        type: member.user.bot ? "bot" : "user",
        originalId: member.id,
        username: tag,
        displayName: member.displayName || member.user.username,
        roles: member.roles.cache.map((r) => r.name),
        joinedAt: member.joinedAt?.getTime ? member.joinedAt.getTime() : undefined,
      },
      member, // Include raw Discord.js member for Discord-specific handling
    } as EventPayload);
  }

  /**
   * Registers slash commands with Discord.
   *
   * This method uses a hybrid permission system that combines:
   * 1. Discord's native permission features (default_member_permissions, contexts)
   * 2. ElizaOS channel whitelist bypass (bypassChannelWhitelist flag)
   * 3. Custom validation functions (validator callback)
   *
   * ## Design Decisions
   *
   * ### Why Hybrid Approach?
   * - Discord's native permissions are powerful but limited to role-based access
   * - ElizaOS needs programmatic control for channel restrictions and custom logic
   * - Combining both gives developers the best of both worlds
   *
   * ### Why Transform Simple Flags?
   * - Developer experience: `guildOnly: true` is clearer than `contexts: [0]`
   * - Abstraction: Shields developers from Discord API changes
   * - Sensible defaults: Zero config should "just work"
   *
   * ### Why Three Registration Categories?
   *
   * Commands are categorized based on where they should be available:
   *
   * 1. **Global commands** (no guildOnly, no guildIds):
   *    - Registered globally via `application.commands.set()` for DM access
   *    - ALSO registered per-guild for instant availability in guilds
   *    - Guild version overrides global (no duplicates shown in Discord)
   *    - Best of both worlds: instant in guilds + works in DMs
   *
   * 2. **Guild-only commands** (guildOnly: true or contexts: [0]):
   *    - Registered per-guild via `application.commands.set(cmds, guildId)`
   *    - NOT available in DMs (correct behavior)
   *    - Instant availability in guilds
   *    - New guilds get commands via guildCreate event
   *
   * 3. **Targeted commands** (has guildIds array):
   *    - Registered only to specified guilds via `.create()` or `.edit()`
   *    - Useful for testing or server-specific features
   *    - Instant updates
   *
   * ### Why Register Global Commands Both Globally AND Per-Guild?
   * - Global registration alone takes up to 1 hour to propagate (Discord limitation)
   * - Per-guild registration gives instant availability
   * - Guild commands override global ones in that guild (no duplicates)
   * - Global registration still needed for DM access (no guild context in DMs)
   *
   * ### Why Not Register Everything Per-Guild Only?
   * - Commands that work in DMs MUST be registered globally
   * - There's no guild context in DMs, so per-guild commands don't appear there
   *
   * @param commands - Array of slash commands to register
   * @returns Promise that resolves when registration is complete
   * @private
   */
  private async registerSlashCommands(commands: DiscordSlashCommand[]): Promise<void> {
    // Wait for the client to be ready before processing
    await this.clientReadyPromise;

    // Helper function to sanitize commands for logging (converts BigInt to string)
    const sanitizeCommandForLogging = (cmd: DiscordSlashCommand): Record<string, unknown> => {
      const sanitized: Record<string, unknown> = {
        name: cmd.name,
        description: cmd.description,
        options: cmd.options,
        contexts: cmd.contexts,
        guildOnly: cmd.guildOnly,
        bypassChannelWhitelist: cmd.bypassChannelWhitelist,
        validator: cmd.validator ? "[Function]" : undefined,
      };

      if (cmd.requiredPermissions !== undefined) {
        sanitized.requiredPermissions =
          typeof cmd.requiredPermissions === "bigint"
            ? cmd.requiredPermissions.toString()
            : cmd.requiredPermissions;
      }

      if (cmd.guildIds) {
        sanitized.guildIds = cmd.guildIds;
      }

      return sanitized;
    };

    // Sanitize commands for logging to handle BigInt values
    const sanitizedCommands = commands.map(sanitizeCommandForLogging);
    this.runtime.logger.debug(
      {
        src: "plugin:discord",
        agentId: this.runtime.agentId,
        commandCount: commands.length,
        commands: sanitizedCommands,
      },
      "Registering Discord commands"
    );

    const clientApplication = this.client?.application;
    if (!clientApplication) {
      this.runtime.logger.warn(
        { src: "plugin:discord", agentId: this.runtime.agentId },
        "Cannot register commands - Discord client application not available"
      );
      return;
    }

    if (!Array.isArray(commands) || commands.length === 0) {
      this.runtime.logger.warn(
        { src: "plugin:discord", agentId: this.runtime.agentId },
        "Cannot register commands - no commands provided"
      );
      return;
    }

    // Validate all commands
    for (const cmd of commands) {
      if (!cmd.name || !cmd.description) {
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            command: sanitizeCommandForLogging(cmd),
          },
          "Cannot register commands - invalid command (missing name or description)"
        );
        return;
      }
    }

    // Queue this registration to prevent race conditions
    let registrationError: Error | null = null;
    let registrationFailed = false;

    this.commandRegistrationQueue = this.commandRegistrationQueue
      .then(async () => {
        // Deduplicate commands by name: merge existing and incoming commands into a map
        // Incoming commands override existing ones with the same name
        const commandMap = new Map<string, DiscordSlashCommand>();

        for (const cmd of this.slashCommands) {
          if (cmd.name) {
            commandMap.set(cmd.name, cmd);
          }
        }

        for (const cmd of commands) {
          if (cmd.name) {
            commandMap.set(cmd.name, cmd);
          }
        }

        this.slashCommands = Array.from(commandMap.values());

        // Rebuild allowAllSlashCommands from the final merged commands
        // This ensures the Set always reflects the authoritative command definitions
        // (handles cases where a command is re-registered without the bypass flag)
        this.allowAllSlashCommands.clear();
        for (const cmd of this.slashCommands) {
          if (cmd.bypassChannelWhitelist) {
            this.allowAllSlashCommands.add(cmd.name);
          }
        }
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            bypassCommands: Array.from(this.allowAllSlashCommands),
          },
          "[DiscordService] Rebuilt bypassChannelWhitelist set from merged commands"
        );

        // Categorize commands for appropriate registration strategy:
        //
        // generalCommands: Commands without specific guildIds (most commands)
        //   ├── globalCommands: Can work in DMs → register globally
        //   └── guildOnlyCommands: Guild-only → register per-guild for instant availability
        //
        // targetedGuildCommands: Commands with specific guildIds → register only to those guilds
        const generalCommands = this.slashCommands.filter(
          (cmd) => !cmd.guildIds || cmd.guildIds.length === 0
        );
        const globalCommands = generalCommands.filter((cmd) => !this.isGuildOnlyCommand(cmd));
        const guildOnlyCommands = generalCommands.filter((cmd) => this.isGuildOnlyCommand(cmd));
        const targetedGuildCommands = this.slashCommands.filter(
          (cmd) => cmd.guildIds && cmd.guildIds.length > 0
        );

        const transformedGlobalCommands = globalCommands.map((cmd) =>
          this.transformCommandToDiscordApi(cmd)
        );
        const transformedGuildOnlyCommands = guildOnlyCommands.map((cmd) =>
          this.transformCommandToDiscordApi(cmd)
        );
        // All general commands (global + guild-only) for per-guild registration
        const transformedAllGeneralCommands = [
          ...transformedGlobalCommands,
          ...transformedGuildOnlyCommands,
        ];

        const clientApplication = this.client?.application;
        if (!clientApplication) {
          this.runtime.logger.error(
            { src: "plugin:discord", agentId: this.runtime.agentId },
            "Cannot register commands - Discord client application is not available"
          );
          throw new Error("Discord client application is not available");
        }

        let globalCommandsRegistered = false;
        let perGuildSucceeded = 0;
        let perGuildFailed = 0;
        let targetedCommandsRegistered = 0;
        let targetedCommandsFailed = 0;

        // 1. Register global commands globally (for DM access)
        // DMs require global registration - there's no guild context.
        // Global commands take up to 1 hour to propagate (Discord limitation),
        // but we also register them per-guild below for instant availability.
        // Always call .set() even with empty array to clear stale global commands
        // (e.g., when all commands become guild-only).
        try {
          await this.client.application.commands.set(transformedGlobalCommands);
          globalCommandsRegistered = true;
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              count: transformedGlobalCommands.length,
            },
            transformedGlobalCommands.length > 0
              ? "Global commands registered (for DM access)"
              : "Global commands cleared (all commands are now guild-only)"
          );
        } catch (err) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to register/clear global commands"
          );
        }

        // 2. Register ALL general commands per-guild for instant availability
        // Why both global AND guild-only?
        // - Guild-only commands: Don't work in DMs, so per-guild is the only option
        // - Global commands: Also registered per-guild for INSTANT availability in guilds
        //   (guild commands override global ones, so no duplicates are shown)
        // This gives us the best of both worlds:
        // - Instant availability in current guilds
        // - DM access via global registration (step 1)
        // - New guilds get commands via guildCreate event
        // Parallel registration for performance.
        const guilds = this.client.guilds.cache;

        if (transformedAllGeneralCommands.length > 0) {
          const guildRegistrations: Promise<{
            guildId: string;
            guildName: string;
            success: boolean;
          }>[] = [];

          for (const [guildId, guild] of guilds) {
            guildRegistrations.push(
              this.client.application.commands
                .set(transformedAllGeneralCommands, guildId)
                .then(() => {
                  this.runtime.logger.debug(
                    {
                      src: "plugin:discord",
                      agentId: this.runtime.agentId,
                      guildId,
                      guildName: guild.name,
                    },
                    "Commands registered to guild"
                  );
                  return { guildId, guildName: guild.name, success: true };
                })
                .catch((err) => {
                  this.runtime.logger.warn(
                    {
                      src: "plugin:discord",
                      agentId: this.runtime.agentId,
                      guildId,
                      guildName: guild.name,
                      error: err.message,
                    },
                    "Failed to register commands to guild"
                  );
                  return { guildId, guildName: guild.name, success: false };
                })
            );
          }

          const perGuildResults = await Promise.all(guildRegistrations);
          perGuildSucceeded = perGuildResults.filter((r) => r.success).length;
          perGuildFailed = perGuildResults.filter((r) => !r.success).length;
        }

        // 3. Register targeted guild commands (commands with specific guildIds)
        // Why individual registration? These commands only go to specific guilds,
        // so we use .create() or .edit() to add them individually rather than
        // replacing all commands in those guilds.
        if (targetedGuildCommands.length > 0) {
          const targetedRegistrations: Promise<void>[] = [];

          for (const cmd of targetedGuildCommands) {
            const transformedCmd = this.transformCommandToDiscordApi(cmd);
            if (cmd.guildIds) {
              for (const guildId of cmd.guildIds) {
                const guild = guilds.get(guildId);
                if (!guild) {
                  this.runtime.logger.warn(
                    {
                      src: "plugin:discord",
                      agentId: this.runtime.agentId,
                      commandName: cmd.name,
                      guildId,
                    },
                    "Cannot register targeted command - bot is not a member of the specified guild"
                  );
                  continue;
                }
                targetedRegistrations.push(
                  (async () => {
                    try {
                      const fullGuild = await guild.fetch();
                      const existingCommands = await fullGuild.commands.fetch();
                      const existingCommand = existingCommands.find((c) => c.name === cmd.name);

                      if (existingCommand) {
                        await existingCommand.edit(
                          transformedCmd as Partial<ApplicationCommandData>
                        );
                        this.runtime.logger.debug(
                          {
                            src: "plugin:discord",
                            agentId: this.runtime.agentId,
                            commandName: cmd.name,
                            guildId: fullGuild.id,
                            guildName: fullGuild.name,
                          },
                          "Updated existing targeted command in guild"
                        );
                      } else {
                        await fullGuild.commands.create(transformedCmd);
                        this.runtime.logger.debug(
                          {
                            src: "plugin:discord",
                            agentId: this.runtime.agentId,
                            commandName: cmd.name,
                            guildId: fullGuild.id,
                            guildName: fullGuild.name,
                          },
                          "Registered targeted command in guild"
                        );
                      }
                      targetedCommandsRegistered++;
                    } catch (error) {
                      targetedCommandsFailed++;
                      this.runtime.logger.error(
                        {
                          src: "plugin:discord",
                          agentId: this.runtime.agentId,
                          commandName: cmd.name,
                          guildId,
                          error: error instanceof Error ? error.message : String(error),
                        },
                        "Failed to register targeted command in guild"
                      );
                    }
                  })()
                );
              }
            }
          }

          await Promise.all(targetedRegistrations);
        }

        this.runtime.logger.info(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            newCommands: commands.length,
            totalCommands: this.slashCommands.length,
            globalCommands: transformedGlobalCommands.length,
            globalCommandsRegisteredForDMs: globalCommandsRegistered,
            guildOnlyCommands: transformedGuildOnlyCommands.length,
            commandsPerGuild: transformedAllGeneralCommands.length,
            guildsSucceeded: perGuildSucceeded,
            guildsFailed: perGuildFailed,
            targetedCommands: targetedGuildCommands.length,
            targetedCommandsRegistered,
            targetedCommandsFailed,
          },
          "Commands registered"
        );
      })
      .catch((error) => {
        registrationFailed = true;
        registrationError = error instanceof Error ? error : new Error(String(error));
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: registrationError.message,
          },
          "Error registering Discord commands"
        );
      });

    await this.commandRegistrationQueue;

    if (registrationFailed && registrationError) {
      throw registrationError;
    }
  }

  /**
   * Transforms an ElizaOS slash command to Discord API format.
   * This bridges our developer-friendly API with Discord's native requirements.
   * @param {DiscordSlashCommand} cmd - The ElizaOS command definition
   * @returns {object} Discord API compatible command object
   * @private
   */
  private transformCommandToDiscordApi(cmd: DiscordSlashCommand): ApplicationCommandDataResolvable {
    // Build the base command structure that Discord.js expects
    const discordCmd: ChatInputApplicationCommandData & {
      contexts?: number[];
      default_member_permissions?: string;
    } = {
      name: cmd.name,
      description: cmd.description,
      options: cmd.options,
    };

    // Transform contexts and guildOnly to Discord's contexts array
    // contexts overrides guildOnly if provided (as documented)
    // Discord contexts: 0=Guild, 1=BotDM, 2=PrivateChannel
    if (cmd.contexts) {
      // Allow raw contexts for advanced use cases - takes precedence over guildOnly
      discordCmd.contexts = cmd.contexts;
    } else if (cmd.guildOnly) {
      // Transform guildOnly flag to Discord's contexts array
      // Why: `guildOnly: true` is more intuitive than `contexts: [0]`
      discordCmd.contexts = [0]; // 0 = Guild only (no DMs)
    }

    // Transform requiredPermissions to Discord's default_member_permissions
    // Why: Leverages Discord's native permission system for role-based access
    // Discord handles the permission checks before the interaction even fires
    if (cmd.requiredPermissions !== undefined) {
      discordCmd.default_member_permissions =
        typeof cmd.requiredPermissions === "bigint"
          ? cmd.requiredPermissions.toString()
          : cmd.requiredPermissions;
    }

    return discordCmd;
  }

  /**
   * Checks if a command is guild-only (shouldn't appear in DMs).
   *
   * A command is considered guild-only if:
   * - `contexts: [0]` is set (Discord's native format, where 0 = Guild only)
   * - `guildOnly: true` is set AND no contexts override is provided
   *
   * `contexts` takes precedence over `guildOnly` to be consistent with
   * `transformCommandToDiscordApi`. { guildOnly: true, contexts: [0, 1] }
   * will correctly enable DM access (not be treated as guild-only).
   *
   * @param {DiscordSlashCommand} cmd - The command to check
   * @returns {boolean} True if the command should only be available in guilds
   * @private
   */
  private isGuildOnlyCommand(cmd: DiscordSlashCommand): boolean {
    // If contexts is provided, it overrides guildOnly (consistent with transformCommandToDiscordApi)
    if (cmd.contexts) {
      // Guild-only if contexts only includes 0 (Guild)
      return cmd.contexts.length === 1 && cmd.contexts[0] === 0;
    }
    // Fall back to guildOnly flag
    return !!cmd.guildOnly;
  }

  /**
   * Handles the event when the bot joins a guild. It logs the guild name, fetches additional information about the guild, scans the guild for voice data, creates standardized world data structure, generates unique IDs, and emits events to the runtime.
   * @param {Guild} guild - The guild that the bot has joined.
   * @returns {Promise<void>} A promise that resolves when the guild creation is handled.
   * @private
   */
  private async handleGuildCreate(guild: Guild) {
    this.runtime.logger.info(`Joined guild: ${guild.name} (${guild.id})`);
    const fullGuild = await guild.fetch();
    // Disabled automatic voice joining - now controlled by joinVoiceChannel action
    // this.voiceManager?.scanGuild(guild);

    // Register commands to the newly joined guild
    // This ensures commands are available immediately when the bot joins a new server
    const clientApplication = this.client?.application;
    if (this.slashCommands.length > 0 && clientApplication) {
      try {
        // 1. General commands (not targeted to specific guilds) - register all of them
        // Why register global commands per-guild too?
        // - Guild commands override global ones (no duplicates shown)
        // - Instant availability vs waiting for global propagation (up to 1 hour)
        // - Global registration still needed for DM access (already done at startup)
        const generalCommands = this.slashCommands.filter(
          (cmd) => !cmd.guildIds || cmd.guildIds.length === 0
        );

        // 2. Targeted commands that include this guild - these may have been skipped
        // during initial registration if the bot wasn't in this guild yet
        const targetedCommandsForThisGuild = this.slashCommands.filter((cmd) =>
          cmd.guildIds?.includes(fullGuild.id)
        );

        // Combine and deduplicate (in case a command appears in both somehow)
        const commandMap = new Map<string, (typeof this.slashCommands)[0]>();
        for (const cmd of [...generalCommands, ...targetedCommandsForThisGuild]) {
          if (cmd.name) {
            commandMap.set(cmd.name, cmd);
          }
        }
        const commandsToRegister = Array.from(commandMap.values());

        if (commandsToRegister.length > 0) {
          // Transform to Discord API format (preserves guildOnly, requiredPermissions, contexts)
          const discordCommands = commandsToRegister.map((cmd) =>
            this.transformCommandToDiscordApi(cmd)
          );

          await this.client.application.commands.set(discordCommands, fullGuild.id);
          this.runtime.logger.info(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              guildId: fullGuild.id,
              guildName: fullGuild.name,
              generalCount: generalCommands.length,
              targetedCount: targetedCommandsForThisGuild.length,
              totalCount: discordCommands.length,
            },
            "Commands registered to newly joined guild"
          );
        }
      } catch (error) {
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            guildId: fullGuild.id,
            guildName: fullGuild.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to register commands to newly joined guild"
        );
      }
    }

    const ownerId = createUniqueUuid(this.runtime, fullGuild.ownerId);

    // Create standardized world data structure
    const worldId = createUniqueUuid(this.runtime, fullGuild.id);
    const standardizedData = {
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
      source: "discord",
    };

    // Emit both Discord-specific and standardized events with the same data structure
    this.runtime.emitEvent([DiscordEventTypes.WORLD_JOINED], {
      runtime: this.runtime,
      source: "discord",
      world: standardizedData.world,
      rooms: standardizedData.rooms,
      entities: standardizedData.entities,
      server: fullGuild,
    } as EventPayload);

    // Emit standardized event with the same structure as WORLD_CONNECTED
    this.runtime.emitEvent([EventType.WORLD_JOINED], standardizedData);
  }

  /**
   * Handles interactions created by the user, specifically commands and message components.
   * @param {Interaction} interaction - The interaction object received.
   * @returns {Promise<void>} A promise that resolves when the interaction is handled.
   * @private
   */
  private async handleInteractionCreate(interaction: Interaction) {
    const entityId = createUniqueUuid(this.runtime, interaction.user.id);
    //this.runtime.logger.debug(`User ${interaction.user.id} => entityId ${entityId}`);
    const userName = interaction.user.bot
      ? `${interaction.user.username}#${interaction.user.discriminator}`
      : interaction.user.username;
    const name = interaction.user.displayName;
    const interactionChannelId = interaction.channel?.id;
    const roomId = createUniqueUuid(this.runtime, interactionChannelId || userName);

    // can't be null
    let type: ChannelType;
    let serverId: string | undefined;

    if (interaction.guild) {
      const guild = await interaction.guild.fetch();
      type = await this.getChannelType(interaction.channel as Channel);
      if (type === null) {
        // usually a forum type post
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelId: interactionChannelId,
          },
          "Null channel type for interaction"
        );
      }
      serverId = guild.id;
    } else {
      type = ChannelType.DM;
      // really can't be undefined because bootstrap's choice action
      serverId = interactionChannelId;
    }

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userName,
      name,
      source: "discord",
      channelId: interactionChannelId,
      // Discord snowflake IDs must be converted to UUIDs using stringToUuid()
      // because messageServerId expects a UUID type, not a raw string
      messageServerId: serverId ? stringToUuid(serverId) : undefined,
      type,
      worldId: createUniqueUuid(this.runtime, serverId ?? roomId) as UUID,
      worldName: interaction.guild?.name || undefined,
    });

    if (interaction.isCommand()) {
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          commandName: interaction.commandName,
          type: interaction.commandType,
          channelId: interaction.channelId,
          inGuild: interaction.inGuild(),
        },
        "[DiscordService] Slash command received"
      );

      try {
        // can't interaction.deferReply if we want to allow custom apps (showModal)
        if (!this.client) {
          return; // Skip if client is not available
        }
        const slashPayload: DiscordSlashCommandPayload = {
          runtime: this.runtime,
          source: "discord",
          interaction,
          client: this.client,
          commands: this.slashCommands,
        };
        this.runtime.emitEvent(DiscordEventTypes.SLASH_COMMAND, slashPayload);
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            commandName: interaction.commandName,
          },
          "[DiscordService] Slash command emitted to runtime"
        );
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            commandName: interaction.commandName,
            error: error instanceof Error ? error.message : String(error),
          },
          "[DiscordService] Failed to emit slash command"
        );
        throw error;
      }
    }

    if (interaction.isModalSubmit()) {
      // this modal.id is stored in interaction.customId
      if (!this.client) {
        return; // Skip if client is not available
      }
      const modalPayload: DiscordSlashCommandPayload = {
        runtime: this.runtime,
        source: "discord",
        interaction,
        client: this.client,
        commands: this.slashCommands,
      };
      this.runtime.emitEvent(DiscordEventTypes.MODAL_SUBMIT, modalPayload);
    }

    // Handle message component interactions (buttons, dropdowns, etc.)
    if (interaction.isMessageComponent()) {
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          customId: interaction.customId,
        },
        "Received component interaction"
      );
      const interactionUser = interaction.user;
      const userId = interactionUser?.id;
      const interactionMessage = interaction.message;
      const messageId = interactionMessage?.id;

      // Initialize user's selections if not exists
      if (!this.userSelections.has(userId)) {
        this.userSelections.set(userId, {});
      }
      const userSelections = this.userSelections.get(userId);
      if (!userSelections) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            entityId: userId,
          },
          "User selections map unexpectedly missing"
        );
        return; // Should not happen
      }

      try {
        // For select menus (type 3), store the values
        if (interaction.isStringSelectMenu()) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              entityId: userId,
              customId: interaction.customId,
              values: interaction.values,
            },
            "Values selected"
          );

          // Store values with messageId to scope them to this specific form
          const existingSelections = (userSelections[messageId] as Record<string, unknown>) || {};
          userSelections[messageId] = {
            ...existingSelections,
            [interaction.customId]: interaction.values,
          };
          // No need to call set again, modification is in place

          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              messageId,
              selections: userSelections[messageId],
            },
            "Current selections for message"
          );

          // Acknowledge the selection
          await interaction.deferUpdate();
          // await interaction.followUp({
          //   content: 'Selection saved!',
          //   ephemeral: true,
          // });
        }

        // For button interactions (type 2), use stored values
        if (interaction.isButton()) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              entityId: userId,
              customId: interaction.customId,
            },
            "Button pressed"
          );
          const formSelections = userSelections[messageId] || {};

          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              formSelections,
            },
            "Form data being submitted"
          );

          // Set up fallback acknowledgement after 2.5 seconds if handler doesn't respond
          // This prevents "Interaction failed" errors while still allowing handlers to show modals
          // Handlers that want to show modals should do so immediately (within 3 seconds)
          const fallbackTimeout = setTimeout(async () => {
            // Remove timeout from array after execution to prevent memory leak
            const index = this.timeouts.indexOf(fallbackTimeout);
            if (index > -1) {
              this.timeouts.splice(index, 1);
            }

            // Check if interaction has already been handled
            if (!interaction.replied && !interaction.deferred) {
              try {
                await interaction.deferUpdate();
                this.runtime.logger.debug(
                  {
                    src: "plugin:discord",
                    agentId: this.runtime.agentId,
                    customId: interaction.customId,
                  },
                  "Acknowledged button interaction via fallback"
                );
              } catch (ackError) {
                // Interaction may have already been acknowledged, expired, or handler responded
                // This is expected and not an error
                this.runtime.logger.debug(
                  {
                    src: "plugin:discord",
                    agentId: this.runtime.agentId,
                    error: ackError instanceof Error ? ackError.message : String(ackError),
                  },
                  "Fallback acknowledgement skipped"
                );
              }
            }
          }, 2500);
          // Store timeout for cleanup on service stop
          this.timeouts.push(fallbackTimeout);

          // Set up a one-time check to clear the timeout early if interaction is acknowledged
          // This prevents unnecessary timeout execution and reduces memory usage
          const earlyCheckTimeout = setTimeout(() => {
            if (interaction.replied || interaction.deferred) {
              clearTimeout(fallbackTimeout);
              // Remove timeout from array since it's been cleared early
              const index = this.timeouts.indexOf(fallbackTimeout);
              if (index > -1) {
                this.timeouts.splice(index, 1);
              }
            }
            // Remove the early check timeout itself from the array
            const earlyIndex = this.timeouts.indexOf(earlyCheckTimeout);
            if (earlyIndex > -1) {
              this.timeouts.splice(earlyIndex, 1);
            }
          }, 2000); // Check once after 2 seconds (before fallback fires)
          // Store early check timeout for cleanup
          this.timeouts.push(earlyCheckTimeout);

          // Emit an event with the interaction data and stored selections
          const interactionPayload: EventPayload & {
            interaction: {
              customId: string;
              componentType: number;
              type: number;
              user: string;
              messageId: string;
              selections: Record<string, unknown>;
            };
            discordInteraction: Interaction;
          } = {
            runtime: this.runtime,
            source: "discord",
            interaction: {
              customId: interaction.customId,
              componentType: interaction.componentType,
              type: interaction.type,
              user: userId,
              messageId,
              selections: formSelections as Record<string, unknown>,
            },
            discordInteraction: interaction,
          };
          this.runtime.emitEvent(["DISCORD_INTERACTION"], interactionPayload);

          // Clear selections for this form only
          delete userSelections[messageId];
          // No need to call set again
          this.runtime.logger.debug(
            { src: "plugin:discord", agentId: this.runtime.agentId, messageId },
            "Cleared selections for message"
          );

          // Fallback timeout acknowledges interaction if handler doesn't.
          // Modal handlers must respond within 3 seconds.
        }
      } catch (error) {
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error handling component interaction"
        );
        try {
          await interaction.followUp({
            content: "There was an error processing your interaction.",
            ephemeral: true,
          });
        } catch (followUpError) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: followUpError instanceof Error ? followUpError.message : String(followUpError),
            },
            "Error sending follow-up message"
          );
        }
      }
    }
  }

  /**
   * Builds a standardized list of rooms from Discord guild channels.
   *
   * @param {Guild} guild The guild to build rooms for.
   * @param {UUID} _worldId The ID of the world to associate with the rooms (currently unused in favor of direct channel to room mapping).
   * @returns {Promise<Array<{ id: UUID; name: string; type: ChannelType; channelId: string; participants: UUID[] }>>} An array of standardized room objects.
   * @private
   */
  private async buildStandardizedRooms(guild: Guild, _worldId: UUID): Promise<Room[]> {
    const rooms: Room[] = [];

    for (const [channelId, channel] of guild.channels.cache) {
      // Only process text and voice channels
      if (
        channel.type === DiscordChannelType.GuildText ||
        channel.type === DiscordChannelType.GuildVoice
      ) {
        const roomId = createUniqueUuid(this.runtime, channelId);
        let channelType: ChannelType;

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
              .filter((member: GuildMember) =>
                channel.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel)
              )
              .map((member: GuildMember) => createUniqueUuid(this.runtime, member.id));
          } catch (error) {
            this.runtime.logger.warn(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                channelId: channel.id,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to get participants for channel"
            );
          }
        }

        rooms.push({
          id: roomId,
          name: channel.name,
          type: channelType,
          channelId: channel.id,
          source: "discord",
          /**
           * Channel topic exposed via metadata for plugin-content-seeder
           *
           * WHY: Discord text channels have an optional "topic" field (the description
           * shown at the top of the channel). This is valuable context for content
           * seeding - it tells us what the channel is actually FOR.
           *
           * We expose it in room metadata so plugins don't need Discord-specific code
           * to access it. This maintains separation of concerns.
           */
          metadata: {
            topic: "topic" in channel ? (channel as TextChannel).topic : undefined,
            participants, // Store participants in metadata for backward compatibility
          },
        });
      }
    }

    return rooms;
  }

  /**
   * Builds a standardized list of users (entities) from Discord guild members.
   * Implements different strategies based on guild size for performance.
   *
   * @param {Guild} guild - The guild from which to build the user list.
   * @returns {Promise<Entity[]>} A promise that resolves with an array of standardized entity objects.
   * @private
   */
  private async buildStandardizedUsers(guild: Guild): Promise<Entity[]> {
    const entities: Entity[] = [];
    const clientUser = this.client?.user;
    const botId = clientUser?.id;

    // Strategy based on guild size
    if (guild.memberCount > 1000) {
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          guildId: guild.id,
          memberCount: guild.memberCount.toLocaleString(),
        },
        "Using optimized user sync for large guild"
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
                new Set(
                  [member.user.username, member.displayName, member.user.globalName].filter(
                    Boolean
                  ) as string[]
                )
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
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              guildId: guild.id,
            },
            "Adding online members"
          );
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
                    new Set(
                      [member.user.username, member.displayName, member.user.globalName].filter(
                        Boolean
                      ) as string[]
                    )
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
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            guildId: guild.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error fetching members"
        );
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
                new Set(
                  [member.user.username, member.displayName, member.user.globalName].filter(
                    Boolean
                  ) as string[]
                )
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
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            guildId: guild.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error fetching members"
        );
      }
    }

    return entities;
  }

  /**
   * Handles tasks to be performed once the Discord client is fully ready and connected.
   * This includes fetching guilds, scanning for voice data, and emitting connection events.
   * @private
   * @returns {Promise<void>} A promise that resolves when all on-ready tasks are completed.
   */
  private async onReady(readyClient) {
    this.runtime.logger.success("Discord client ready");

    // Initialize slash commands array (empty initially - commands registered via DISCORD_REGISTER_COMMANDS)
    this.slashCommands = [];

    /**
     * DISCORD_REGISTER_COMMANDS event handler
     *
     * Delegates to registerSlashCommands() method.
     *
     * @param params.commands - Array of commands to register
     */
    this.runtime.registerEvent(
      "DISCORD_REGISTER_COMMANDS",
      async (params: DiscordRegisterCommandsPayload) => {
        await this.registerSlashCommands(params.commands);
      }
    );

    // Check if audit log tracking is enabled (for permission change events)
    const auditLogSettingForInvite = this.runtime.getSetting("DISCORD_AUDIT_LOG_ENABLED");
    const isAuditLogEnabledForInvite =
      auditLogSettingForInvite !== "false" && auditLogSettingForInvite !== false;

    // Generate invite URL using centralized permission tiers (MODERATOR_VOICE is recommended default)
    // If DISCORD_AUDIT_LOG_ENABLED, manually grant ViewAuditLog permission per-server after joining.
    const readyClientUser = readyClient.user;
    const inviteUrl = readyClientUser?.id
      ? generateInviteUrl(readyClientUser.id, "MODERATOR_VOICE")
      : undefined;

    // Log a note if audit log tracking is enabled
    if (isAuditLogEnabledForInvite) {
      this.runtime.logger.info(
        { src: "plugin:discord", agentId: this.runtime.agentId },
        "Audit log tracking enabled - ensure bot has ViewAuditLog permission in server settings"
      );
    }

    // Use character name if available, otherwise fallback to username, then agentId
    const agentName =
      this.runtime.character.name || readyClientUser?.username || this.runtime.agentId;

    if (inviteUrl) {
      this.runtime.logger.info(
        { src: "plugin:discord", agentId: this.runtime.agentId, inviteUrl },
        "Bot invite URL generated"
      );
      this.runtime.logger.info(
        `Use this URL to add the "${agentName}" bot to your Discord server: ${inviteUrl}`
      );
    } else {
      this.runtime.logger.warn(
        { src: "plugin:discord", agentId: this.runtime.agentId },
        "Could not generate invite URL - bot user ID unavailable"
      );
    }

    this.runtime.logger.success(
      `Discord client logged in successfully as ${readyClientUser?.username || agentName}`
    );

    const guilds = this.client ? await this.client.guilds.fetch() : null;
    if (!guilds) {
      this.runtime.logger.warn("Could not fetch guilds");
      return;
    }
    for (const [, guild] of guilds) {
      // Disabled automatic voice joining - now controlled by joinVoiceChannel action
      // await this.voiceManager?.scanGuild(fullGuild);

      // Send after a brief delay
      const timeoutId = setTimeout(async () => {
        // For each server the client is in, fire a connected event
        try {
          const fullGuild = await guild.fetch();
          this.runtime.logger.info(`Discord server connected: ${fullGuild.name} (${fullGuild.id})`);

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
            source: "discord",
          };

          // Emit Discord-specific event with full guild object
          this.runtime.emitEvent([DiscordEventTypes.WORLD_CONNECTED], {
            runtime: this.runtime,
            source: "discord",
            world: standardizedData.world,
            rooms: standardizedData.rooms,
            entities: standardizedData.entities,
            server: fullGuild,
          } as EventPayload);

          // Emit standardized event
          this.runtime.emitEvent([EventType.WORLD_CONNECTED], standardizedData);
        } catch (error) {
          // Add error handling to prevent crashes if the client is already destroyed
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error during Discord world connection"
          );
        }
      }, 1000);

      // Store the timeout reference to be able to cancel it when stopping
      this.timeouts.push(timeoutId);
    }

    // Validate audit log access for permission tracking (if enabled)
    const auditLogEnabled = this.runtime.getSetting("DISCORD_AUDIT_LOG_ENABLED");
    if (auditLogEnabled !== "false" && auditLogEnabled !== false) {
      try {
        const testGuild = guilds.first();
        if (testGuild) {
          const fullGuild = await testGuild.fetch();
          await fullGuild.fetchAuditLogs({ limit: 1 });
          this.runtime.logger.debug("Audit log access verified for permission tracking");
        }
      } catch (err) {
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: err instanceof Error ? err.message : String(err),
          },
          "Cannot access audit logs - permission change alerts will not include executor info"
        );
      }
    }

    if (this.client) {
      this.client.emit("voiceManagerReady");
    }
  }

  /**
   * Registers send handlers for the Discord service instance.
   * This allows the runtime to correctly dispatch messages to this service.
   * @param {IAgentRuntime} runtime - The agent runtime instance.
   * @param {DiscordService} serviceInstance - The instance of the DiscordService.
   * @static
   */
  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: DiscordService) {
    if (serviceInstance) {
      runtime.registerSendHandler(
        "discord",
        serviceInstance.handleSendMessage.bind(serviceInstance)
      );
      runtime.logger.info("Registered send handler");
    }
  }

  /**
   * Fetches all members who have access to a specific text channel.
   *
   * @param {string} channelId - The Discord ID of the text channel.
   * @param {boolean} [useCache=true] - Whether to prioritize cached data. Defaults to true.
   * @returns {Promise<Array<{id: string, username: string, displayName: string}>>} A promise that resolves with an array of channel member objects, each containing id, username, and displayName.
   */
  public async getTextChannelMembers(
    channelId: string,
    useCache: boolean = true
  ): Promise<Array<{ id: string; username: string; displayName: string }>> {
    this.runtime.logger.debug(
      {
        src: "plugin:discord",
        agentId: this.runtime.agentId,
        channelId,
        useCache,
      },
      "Fetching members for text channel"
    );

    try {
      // Fetch the channel
      const channel = this.client
        ? ((await this.client.channels.fetch(channelId)) as TextChannel)
        : null;

      // Validate channel
      if (!channel) {
        this.runtime.logger.error(
          { src: "plugin:discord", agentId: this.runtime.agentId, channelId },
          "Channel not found"
        );
        return [];
      }

      if (channel.type !== DiscordChannelType.GuildText) {
        this.runtime.logger.error(
          { src: "plugin:discord", agentId: this.runtime.agentId, channelId },
          "Channel is not a text channel"
        );
        return [];
      }

      const guild = channel.guild;
      if (!guild) {
        this.runtime.logger.error(
          { src: "plugin:discord", agentId: this.runtime.agentId, channelId },
          "Channel is not in a guild"
        );
        return [];
      }

      // Determine strategy based on guild size and cache preference
      const useCacheOnly = useCache && guild.memberCount > 1000;
      let members: Collection<string, GuildMember>;

      if (useCacheOnly) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            guildId: guild.id,
            memberCount: guild.memberCount.toLocaleString(),
          },
          "Using cached members for large guild"
        );
        members = guild.members.cache;
      } else {
        // For smaller guilds or when cache is not preferred, fetch members
        try {
          if (useCache && guild.members.cache.size > 0) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                cacheSize: guild.members.cache.size,
              },
              "Using cached members"
            );
            members = guild.members.cache;
          } else {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                guildId: guild.id,
              },
              "Fetching members for guild"
            );
            members = await guild.members.fetch();
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                memberCount: members.size.toLocaleString(),
              },
              "Fetched members"
            );
          }
        } catch (error) {
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Error fetching members"
          );
          // Fallback to cache if fetch fails
          members = guild.members.cache;
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              cacheSize: members.size,
            },
            "Fallback to cache"
          );
        }
      }

      // Filter members by permission to view the channel
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          channelId: channel.id,
        },
        "Filtering members for channel access"
      );
      // Explicitly type the array from values()
      const memberArray: GuildMember[] = Array.from(members.values());
      const channelMembers = memberArray
        .filter((member: GuildMember) => {
          // Skip bots except our own bot
          // Add null check for client and client.user
          const clientUser = this.client?.user;
          if (member.user.bot && clientUser && member.id !== clientUser.id) {
            return false;
          }

          // Check if the member can view the channel
          return (
            channel.permissionsFor(member)?.has(PermissionsBitField.Flags.ViewChannel) || false
          );
        })
        .map((member: GuildMember) => ({
          id: member.id,
          username: member.user.username,
          displayName: member.displayName || member.user.username,
        }));

      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          channelId: channel.id,
          memberCount: channelMembers.length.toLocaleString(),
        },
        "Found members with channel access"
      );
      return channelMembers;
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error fetching channel members"
      );
      return [];
    }
  }

  /**
   * Fetches the topic/description of a Discord text channel.
   *
   * WHY THIS METHOD EXISTS:
   * =======================
   * Room metadata contains topic from initial sync, but channel topics can change.
   * This method lets plugins fetch FRESH topic data directly from Discord API.
   *
   * Used by plugin-content-seeder to get authoritative topic data for discussion seeding.
   *
   * WHY NOT JUST USE METADATA:
   * Room.metadata.topic is set at sync time and may be stale if the Discord admin
   * updates the channel topic. For plugins that care about freshness, this method
   * provides a way to get current data.
   *
   * TRADEOFF: This makes an API call, so it's slower than reading metadata.
   * Use metadata for most cases, this method when freshness matters.
   *
   * @param {string} channelId - The Discord ID of the text channel.
   * @returns {Promise<string | null>} The channel topic, or null if not available.
   */
  public async getChannelTopic(channelId: string): Promise<string | null> {
    try {
      const channel = this.client ? await this.client.channels.fetch(channelId) : null;
      if (channel && "topic" in channel) {
        return (channel as TextChannel).topic;
      }
      return null;
    } catch (error) {
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to fetch channel topic"
      );
      return null;
    }
  }

  /**
   * Generic handler for reaction events (add/remove).
   * @private
   */
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    type: "add" | "remove"
  ) {
    try {
      const actionVerb = type === "add" ? "added" : "removed";
      const actionText = type === "add" ? "Added" : "Removed";
      const preposition = type === "add" ? "to" : "from";

      this.runtime.logger.debug(
        { src: "plugin:discord", agentId: this.runtime.agentId, type },
        `Reaction ${actionVerb}`
      );

      // Early returns
      if (!reaction || !user) {
        this.runtime.logger.warn("Invalid reaction or user");
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
          this.runtime.logger.error(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to fetch partial reaction"
          );
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
        this.runtime.logger.error(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            entityId,
            roomId,
          },
          "Invalid user ID or room ID"
        );
        return;
      }

      // Process message content
      const messageContent = reaction.message.content || "";
      const truncatedContent =
        messageContent.length > 50 ? `${messageContent.substring(0, 50)}...` : messageContent;
      const reactionMessage = `*${actionText} <${emoji}> ${preposition}: \\"${truncatedContent}\\"*`;

      // Get user info from the reacting user (not the message author)
      const reactionMessageAuthor = reaction.message.author;
      const userName =
        ("username" in user && (user as User).username) ||
        reactionMessageAuthor?.username ||
        "unknown";
      const name =
        // Prefer any display/global name if present
        ("globalName" in user && typeof user.globalName === "string"
          ? user.globalName
          : undefined) ||
        (reactionMessageAuthor &&
        "displayName" in reactionMessageAuthor &&
        typeof reactionMessageAuthor.displayName === "string"
          ? reactionMessageAuthor.displayName
          : undefined) ||
        userName;

      // Get channel type once and reuse
      const channelType = await this.getChannelType(reaction.message.channel as Channel);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        worldId: createUniqueUuid(this.runtime, reaction.message.guild?.id ?? roomId) as UUID,
        worldName: reaction.message.guild?.name || undefined,
        name,
        source: "discord",
        channelId: reaction.message.channel.id,
        messageServerId: reaction.message.guild?.id
          ? stringToUuid(reaction.message.guild.id)
          : undefined,
        type: channelType,
      });

      const inReplyTo = createUniqueUuid(this.runtime, reaction.message.id);

      const memory: Memory = {
        id: reactionUUID,
        entityId,
        agentId: this.runtime.agentId,
        content: {
          text: reactionMessage,
          source: "discord",
          inReplyTo,
          channelType,
        },
        roomId,
        createdAt: timestamp,
      };

      const callback: HandlerCallback = async (content): Promise<Memory[]> => {
        if (!reaction.message.channel) {
          this.runtime.logger.error(
            { src: "plugin:discord", agentId: this.runtime.agentId },
            "No channel found for reaction message"
          );
          return [];
        }
        await (reaction.message.channel as TextChannel).send(content.text ?? "");
        return [];
      };

      // Emit appropriate events based on type (both Discord-specific and core events)
      // New core only has REACTION_RECEIVED (no REACTION_REMOVED).
      // For forward compat, removals only emit Discord-specific event.
      const events =
        type === "add"
          ? [DiscordEventTypes.REACTION_RECEIVED, EventType.REACTION_RECEIVED]
          : [DiscordEventTypes.REACTION_REMOVED];

      const reactionPayload: DiscordReactionPayload & EventPayload = {
        runtime: this.runtime,
        message: memory,
        originalReaction: reaction as MessageReaction,
        user: user as User,
        source: "discord",
        callback,
      };
      this.runtime.emitEvent(events, reactionPayload);
    } catch (error) {
      this.runtime.logger.error(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error handling reaction"
      );
    }
  }

  /**
   * Handles reaction addition.
   * @private
   */
  private async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    await this.handleReaction(reaction, user, "add");
  }

  /**
   * Handles reaction removal.
   * @private
   */
  private async handleReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ) {
    await this.handleReaction(reaction, user, "remove");
  }

  /**
   * Checks if a channel ID is allowed based on both env config and dynamic additions.
   * @param {string} channelId - The channel ID to check
   * @returns {boolean} Whether the channel is allowed
   */
  public isChannelAllowed(channelId: string): boolean {
    // If no restrictions are set, allow all channels
    if (!this.allowedChannelIds) {
      return true;
    }

    // Check if channel is in the env-configured list or dynamically added
    return this.allowedChannelIds.includes(channelId) || this.dynamicChannelIds.has(channelId);
  }

  /**
   * Adds a channel to the dynamic allowed list.
   * @param {string} channelId - The channel ID to add
   * @returns {boolean} Whether the channel was successfully added
   */
  public addAllowedChannel(channelId: string): boolean {
    // Validate the channel exists
    if (!this.client || !this.client.channels.cache.has(channelId)) {
      return false;
    }

    this.dynamicChannelIds.add(channelId);
    return true;
  }

  /**
   * Removes a channel from the dynamic allowed list.
   * @param {string} channelId - The channel ID to remove
   * @returns {boolean} Whether the channel was in the list and removed
   */
  public removeAllowedChannel(channelId: string): boolean {
    // Don't allow removing channels that are in the env config
    if (this.allowedChannelIds?.includes(channelId)) {
      return false;
    }

    return this.dynamicChannelIds.delete(channelId);
  }

  /**
   * Gets the list of all allowed channels (env + dynamic).
   * @returns {string[]} Array of allowed channel IDs
   */
  public getAllowedChannels(): string[] {
    const envChannels = this.allowedChannelIds || [];
    const dynamicChannels = Array.from(this.dynamicChannelIds);
    return [...new Set([...envChannels, ...dynamicChannels])];
  }

  /**
   * Type guard to check if a channel is a guild text-based channel
   * @private
   */
  private isGuildTextBasedChannel(channel: Channel | null): channel is GuildTextBasedChannel {
    return (
      !!channel &&
      "isTextBased" in channel &&
      typeof channel.isTextBased === "function" &&
      channel.isTextBased() &&
      "guild" in channel &&
      channel.guild !== null
    );
  }

  /**
   * Helper to delay execution
   * @private
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get spider state for a channel from the database
   * @private
   */
  private async getSpiderState(channelId: string): Promise<ChannelSpiderState | null> {
    try {
      // Create a deterministic UUID for this channel's spider state
      const stateId = createUniqueUuid(this.runtime, `discord-spider-state-${channelId}`);

      // Try to get the state memory from the database
      const stateMemory = await this.runtime.getMemoryById(stateId);

      const stateMemoryContent = stateMemory?.content;
      if (stateMemoryContent?.text) {
        const state = JSON.parse(stateMemory.content.text) as ChannelSpiderState;
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelId,
            state,
          },
          "Loaded spider state from database"
        );
        return state;
      }
    } catch (error) {
      this.runtime.logger.warn(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
          channelId,
        },
        "Failed to load spider state from database"
      );
    }
    return null;
  }

  /**
   * Save spider state for a channel to the database
   * @private
   */
  private async saveSpiderState(state: ChannelSpiderState): Promise<void> {
    try {
      // Create a deterministic UUID for this channel's spider state
      const stateId = createUniqueUuid(this.runtime, `discord-spider-state-${state.channelId}`);
      const roomId = createUniqueUuid(this.runtime, state.channelId);

      this.runtime.logger.debug(
        `[SpiderState] Saving channel=${state.channelId} stateId=${stateId}`
      );

      // Check if state already exists - if so, delete it first
      let existing: Memory | null = null;
      try {
        existing = await this.runtime.getMemoryById(stateId);
        this.runtime.logger.debug(
          `[SpiderState] getMemoryById: ${existing ? "EXISTS" : "NOT_FOUND"}`
        );
      } catch (lookupError) {
        const lookupErrorMessage =
          lookupError instanceof Error ? lookupError.message : String(lookupError);
        this.runtime.logger.debug(`[SpiderState] getMemoryById error: ${lookupErrorMessage}`);
      }

      if (existing) {
        this.runtime.logger.debug("[SpiderState] Deleting existing state before insert");
        try {
          await this.runtime.deleteMemory(stateId);
          this.runtime.logger.debug("[SpiderState] Delete successful");
        } catch (deleteError) {
          const deleteErrorMessage =
            deleteError instanceof Error ? deleteError.message : String(deleteError);
          this.runtime.logger.debug(`[SpiderState] Delete error: ${deleteErrorMessage}`);
        }
      }

      // Ensure the world, room, entity, and connection exist before saving
      // This is required because the memories table has foreign key constraints
      // on roomId and entityId
      let serverId: string | undefined;
      let worldId: UUID;
      let channelName = state.channelId;

      // Try to get channel info from Discord to get serverId
      try {
        if (this.client?.isReady?.()) {
          const channel = await this.client.channels.fetch(state.channelId);
          if (channel && "guild" in channel && channel.guild) {
            serverId = channel.guild.id;
            channelName = "name" in channel ? (channel.name ?? state.channelId) : state.channelId;
          }
        }
      } catch {
        // If we can't fetch the channel, use a default serverId
      }

      // Create worldId based on serverId or channelId
      worldId = createUniqueUuid(this.runtime, serverId ?? state.channelId);

      // Ensure the entity exists (use agent as entity for spider state)
      const entityId = this.runtime.agentId;
      try {
        const entity = await this.runtime.getEntityById(entityId);
        if (!entity) {
          // Create the entity for the agent
          await this.runtime.createEntity({
            id: entityId,
            names: ["Spider"],
            agentId: this.runtime.agentId,
            metadata: { source: "discord-spider" },
          });
          this.runtime.logger.debug("[SpiderState] Created entity for agent");
        }
      } catch (entityError) {
        // Entity might already exist (duplicate key), which is fine
        const entityErrorMessage =
          entityError instanceof Error ? entityError.message : String(entityError);
        if (!entityErrorMessage.includes("duplicate key")) {
          this.runtime.logger.debug(`[SpiderState] Entity ensure error: ${entityErrorMessage}`);
        }
      }

      // Ensure world exists
      try {
        await this.runtime.ensureWorldExists({
          id: worldId,
          name: serverId ? `Discord Server ${serverId}` : `Spider World ${state.channelId}`,
          agentId: this.runtime.agentId,
          messageServerId: stringToUuid(serverId ?? state.channelId),
        });
        this.runtime.logger.debug(`[SpiderState] World ensured: ${worldId}`);
      } catch (worldError) {
        const worldErrorMessage =
          worldError instanceof Error ? worldError.message : String(worldError);
        this.runtime.logger.debug(`[SpiderState] World ensure error: ${worldErrorMessage}`);
      }

      // Ensure room exists
      try {
        await this.runtime.ensureRoomExists({
          id: roomId,
          name: channelName,
          source: "discord",
          type: ChannelType.GROUP,
          channelId: state.channelId,
          messageServerId: stringToUuid(serverId ?? state.channelId),
          worldId,
        });
        this.runtime.logger.debug(`[SpiderState] Room ensured: ${roomId}`);
      } catch (roomError) {
        const roomErrorMessage = roomError instanceof Error ? roomError.message : String(roomError);
        this.runtime.logger.debug(`[SpiderState] Room ensure error: ${roomErrorMessage}`);
      }

      // Ensure participant (connection) exists
      try {
        await this.runtime.ensureParticipantInRoom(entityId, roomId);
        this.runtime.logger.debug("[SpiderState] Participant ensured in room");
      } catch (participantError) {
        // Try addParticipant as fallback
        try {
          await this.runtime.addParticipant(entityId, roomId);
          this.runtime.logger.debug("[SpiderState] Participant added to room");
        } catch {
          const participantErrorMessage = participantError?.message
            ? participantError.message
            : String(participantError);
          this.runtime.logger.debug(
            `[SpiderState] Participant ensure error: ${participantErrorMessage}`
          );
        }
      }

      // Create the state memory
      const stateMemory: Memory = {
        id: stateId,
        agentId: this.runtime.agentId,
        entityId,
        roomId,
        content: {
          text: JSON.stringify(state),
          source: "discord-spider",
        },
        metadata: {
          type: MemoryType.CUSTOM,
          source: "discord-spider-state",
          channelId: state.channelId,
          fullyBackfilled: state.fullyBackfilled,
        } satisfies CustomMetadata,
        createdAt: Date.now(),
      };

      // Store in the database
      this.runtime.logger.debug("[SpiderState] Inserting new state");
      await this.runtime.createMemory(stateMemory, "custom");

      this.runtime.logger.debug(`[SpiderState] Save successful for channel ${state.channelId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Extract the underlying cause from DrizzleQueryError
      const errorCause =
        error &&
        (
          error as {
            cause?: { message?: string; code?: string; detail?: string };
          }
        ).cause;
      const causeMsg = errorCause?.message || (errorCause ? String(errorCause) : "");
      const causeCode = errorCause?.code || "";
      const causeDetail = errorCause?.detail || "";

      // Check if this is a duplicate key error
      if (
        errorMsg.includes("duplicate key") ||
        errorMsg.includes("unique constraint") ||
        String(causeMsg).includes("duplicate key") ||
        String(causeMsg).includes("unique constraint")
      ) {
        this.runtime.logger.debug(
          "[SpiderState] Duplicate key - state already saved by another operation"
        );
      } else {
        this.runtime.logger.warn(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            error: errorMsg,
            cause: String(causeMsg),
            causeCode,
            causeDetail,
            channelId: state.channelId,
          },
          "Failed to save spider state to database"
        );
      }
    }
  }

  /**
   * Fetches and persists message history from a Discord channel.
   * Supports pagination, state tracking, and streaming via callback.
   *
   * Persistence behavior:
   * - When `onBatch` callback is NOT provided: Messages are automatically persisted
   *   to the database and accumulated in the returned `messages` array.
   * - When `onBatch` callback IS provided: Messages are passed to the callback and
   *   the caller is responsible for persistence. This allows for custom handling.
   *
   * @param {string} channelId - The Discord channel ID to fetch from
   * @param {ChannelHistoryOptions} options - Options for the fetch operation
   * @returns {Promise<ChannelHistoryResult>} The result with messages and stats
   */
  public async fetchChannelHistory(
    channelId: string,
    options: ChannelHistoryOptions = {}
  ): Promise<ChannelHistoryResult> {
    if (!this.client || !this.client.isReady || !this.client.isReady()) {
      this.runtime.logger.warn(
        { src: "plugin:discord", agentId: this.runtime.agentId, channelId },
        "Discord client not ready for history fetch"
      );
      return {
        messages: [],
        stats: { fetched: 0, stored: 0, pages: 0, fullyBackfilled: false },
      };
    }

    // Fetch the channel
    const fetchedChannel = await this.client.channels.fetch(channelId);
    if (!this.isGuildTextBasedChannel(fetchedChannel)) {
      this.runtime.logger.warn(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          channelId,
          channelType: fetchedChannel?.type ?? null,
        },
        "Channel is not a guild text-based channel"
      );
      return {
        messages: [],
        stats: { fetched: 0, stored: 0, pages: 0, fullyBackfilled: false },
      };
    }

    const channel = fetchedChannel as GuildTextBasedChannel;
    const serverId =
      "guild" in channel && channel.guild
        ? channel.guild.id
        : "guildId" in channel && channel.guildId
          ? channel.guildId
          : channel.id;
    const worldId = serverId ? createUniqueUuid(this.runtime, serverId) : this.runtime.agentId;

    // Ensure world and room exist
    await this.runtime.ensureWorldExists({
      id: worldId,
      agentId: this.runtime.agentId,
      messageServerId: stringToUuid(serverId),
      name: (() => {
        const channelGuild = "guild" in channel ? channel.guild : null;
        return channelGuild?.name || "Discord";
      })(),
    });

    await this.runtime.ensureRoomExists({
      id: createUniqueUuid(this.runtime, channel.id),
      agentId: this.runtime.agentId,
      name: ("name" in channel && channel.name) || channel.id,
      source: "discord",
      type: await this.getChannelType(channel as Channel),
      channelId: channel.id,
      messageServerId: stringToUuid(serverId),
      worldId,
    });

    // Load spider state
    const spiderState = options.force ? null : await this.getSpiderState(channelId);
    const channelName = ("name" in channel && channel.name) || channelId;

    let consecutiveNoNew = 0;
    let totalStored = 0;
    let totalFetched = 0;
    let pagesProcessed = 0;
    const allMessages: Memory[] = [];
    const startTime = Date.now();
    // Track entity IDs we've already ensured connections for (optimization across batches)
    const ensuredEntityIds = new Set<string>();

    // Initialize from spider state if available, otherwise from options
    let oldestMessageId: string | undefined = spiderState?.oldestMessageId ?? options.before;
    let newestMessageId: string | undefined = spiderState?.newestMessageId ?? options.after;
    let oldestMessageTimestamp: number | undefined = spiderState?.oldestMessageTimestamp;
    let newestMessageTimestamp: number | undefined = spiderState?.newestMessageTimestamp;
    let reachedEnd = false;

    // Phase 1: If we have previous state, first catch up on new messages
    // This ensures we don't miss messages that arrived while spider was stopped
    // We paginate BACKWARD from the present to our known history to avoid
    // Discord's `after` pagination issues where newest messages are returned first
    if (!options.force && spiderState && spiderState.newestMessageId) {
      const lastDate = spiderState.newestMessageTimestamp
        ? new Date(spiderState.newestMessageTimestamp).toISOString().split("T")[0]
        : "unknown";
      this.runtime.logger.info(`#${channelName}: Catching up on new messages since ${lastDate}`);

      // Collect all catch-up batches first (paginating backward from present)
      const catchUpBatches: Message[][] = [];
      let catchUpBefore: string | undefined; // Start from present (no before = newest messages)
      let _catchUpPages = 0;
      let reachedKnownHistory = false;

      while (!reachedKnownHistory) {
        _catchUpPages++;
        const fetchParams: { limit: number; before?: string } = { limit: 100 };
        if (catchUpBefore) {
          fetchParams.before = catchUpBefore;
        }

        const batch = await channel.messages.fetch(fetchParams);
        if (batch.size === 0) {
          break;
        }

        const messages = Array.from(batch.values() as IterableIterator<Message>).sort(
          (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0)
        );

        // Check if we've reached or passed our known newest message
        const knownNewestTimestamp = spiderState.newestMessageTimestamp ?? 0;
        const knownNewestId = spiderState.newestMessageId;
        const filteredMessages: Message[] = [];
        for (const msg of messages) {
          const msgTimestamp = msg.createdTimestamp ?? 0;
          // Include messages NEWER than our known newest, OR same timestamp but different ID
          // This handles the edge case where multiple messages share the same millisecond timestamp
          if (msgTimestamp > knownNewestTimestamp) {
            filteredMessages.push(msg);
          } else if (msgTimestamp === knownNewestTimestamp && msg.id !== knownNewestId) {
            // Same timestamp but different message - include it (could be a concurrent message)
            filteredMessages.push(msg);
          } else {
            // We've reached our known history (exact match or older)
            reachedKnownHistory = true;
          }
        }

        if (filteredMessages.length > 0) {
          catchUpBatches.push(filteredMessages);
        }

        // If batch was full and we haven't reached known history, continue backward
        if (batch.size < 100 || reachedKnownHistory) {
          break;
        }

        // Advance backward: get messages before the oldest in current batch
        const batchLast = batch.last();
        catchUpBefore = batchLast?.id;
        await this.delay(250);
      }

      // Process catch-up batches in chronological order (oldest first)
      // Reverse because we collected backward (newest batches first)
      catchUpBatches.reverse();

      let catchUpBatchIndex = 0;
      for (let messages of catchUpBatches) {
        catchUpBatchIndex++;

        // Enforce limit by slicing batch if we're close to the limit
        if (options.limit) {
          const remaining = options.limit - totalFetched;
          if (remaining <= 0) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                channelId,
                limit: options.limit,
              },
              "Reached fetch limit during catch-up"
            );
            break;
          }
          if (messages.length > remaining) {
            messages = messages.slice(0, remaining);
          }
        }

        totalFetched += messages.length;
        pagesProcessed++;

        // Update newest tracking
        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          const lastTimestamp = lastMsg.createdTimestamp ?? 0;
          if (!newestMessageTimestamp || lastTimestamp > newestMessageTimestamp) {
            newestMessageId = lastMsg.id;
            newestMessageTimestamp = lastTimestamp;
          }
        }

        // Build and process memories, tracking new vs existing
        let catchUpNewCount = 0;
        let catchUpExistingCount = 0;
        const catchUpBatchMemories: Memory[] = [];

        // Build all memories first
        const allMemories: Memory[] = [];
        for (const discordMessage of messages) {
          const memory = await this.buildMemoryFromMessage(discordMessage);
          if (memory?.id) {
            allMemories.push(memory);
          }
        }

        // Batch check which memories already exist (single DB query)
        if (allMemories.length > 0) {
          const memoryIds = allMemories
            .map((m) => m.id)
            .filter((id): id is UUID => id !== undefined);
          const existingMemories = await this.runtime.getMemoriesByIds(memoryIds, "messages");
          const existingIdSet = new Set(existingMemories.map((m) => m.id));

          // Filter to only new memories
          for (const memory of allMemories) {
            if (memory.id && existingIdSet.has(memory.id)) {
              catchUpExistingCount++;
            } else {
              catchUpNewCount++;
              catchUpBatchMemories.push(memory);
            }
          }
        }

        // Process batch via callback or persist and accumulate
        if (options.onBatch) {
          // Caller handles persistence via callback
          const shouldContinue = await options.onBatch(catchUpBatchMemories, {
            page: pagesProcessed,
            totalFetched,
            totalStored: totalStored + catchUpBatchMemories.length,
          });

          // Assume caller persists all memories when using onBatch
          totalStored += catchUpBatchMemories.length;

          if (shouldContinue === false) {
            this.runtime.logger.debug(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                channelId,
                page: pagesProcessed,
              },
              "Batch handler requested early stop during catch-up"
            );
            break;
          }
        } else {
          // Ensure entity connections exist before persisting (prevents FK constraint failures)
          await this.ensureConnectionsForMessages(messages, ensuredEntityIds);

          // Persist memories to database, only count successfully persisted
          const successfullyPersisted: Memory[] = [];
          for (const memory of catchUpBatchMemories) {
            try {
              await this.runtime.createMemory(memory, "messages");
              successfullyPersisted.push(memory);
            } catch (error) {
              this.runtime.logger.warn(
                {
                  src: "plugin:discord",
                  agentId: this.runtime.agentId,
                  memoryId: memory.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                "Failed to persist memory during catch-up"
              );
            }
          }
          allMessages.push(...successfullyPersisted);
          totalStored += successfullyPersisted.length;
        }

        // Determine HIT (all existed) or MISS (had new messages)
        const catchUpHitMiss =
          catchUpExistingCount > 0 && catchUpNewCount === 0
            ? "HIT"
            : catchUpNewCount > 0
              ? "MISS"
              : "EMPTY";

        // Save progress
        await this.saveSpiderState({
          channelId,
          oldestMessageId,
          newestMessageId,
          oldestMessageTimestamp,
          newestMessageTimestamp,
          lastSpideredAt: Date.now(),
          fullyBackfilled: spiderState.fullyBackfilled,
        });

        // Debug log for each catch-up batch
        const newestDate = newestMessageTimestamp
          ? new Date(newestMessageTimestamp).toISOString().split("T")[0]
          : "?";
        const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
        this.runtime.logger.debug(
          `#${channelName}: Catch-up batch ${catchUpBatchIndex}/${catchUpBatches.length} [${catchUpHitMiss}], ${messages.length} msgs fetched (${catchUpNewCount} new, ${catchUpExistingCount} existing), ${totalFetched} total fetched, ${totalStored} total stored, newest date ${newestDate} (${elapsedSec}s)`
        );
      }

      if (catchUpBatches.length > 0) {
        this.runtime.logger.info(
          `#${channelName}: Caught up ${catchUpBatches.length} batches of new messages`
        );
      }
    }

    // Phase 2: Determine backfill direction
    let before: string | undefined = options.before;
    let after: string | undefined = options.after;

    if (!options.force && spiderState) {
      if (spiderState.fullyBackfilled) {
        // Already caught up above, we're done with fetching
        reachedEnd = true;
      } else {
        // Continue backfilling from where we left off
        before = spiderState.oldestMessageId;
        const oldestDate = spiderState.oldestMessageTimestamp
          ? new Date(spiderState.oldestMessageTimestamp).toISOString().split("T")[0]
          : "unknown";
        this.runtime.logger.info(`#${channelName}: Resuming backfill from ${oldestDate}`);
      }
    } else if (!spiderState) {
      this.runtime.logger.info(`#${channelName}: Starting fresh history fetch`);
    }

    // Phase 3: Backfill older messages (skip if already fully backfilled)
    while (!reachedEnd) {
      // Check limit before fetching to avoid unnecessary API calls
      if (options.limit && totalFetched >= options.limit) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelId,
            limit: options.limit,
          },
          "Reached fetch limit before backfill batch"
        );
        break;
      }

      pagesProcessed += 1;
      // Adjust fetch limit based on remaining quota to avoid exceeding options.limit
      const remaining = options.limit ? options.limit - totalFetched : 100;
      const fetchLimit = Math.min(100, remaining);
      const fetchParams: Record<string, unknown> = { limit: fetchLimit };

      if (after) {
        fetchParams.after = after;
      } else if (before) {
        fetchParams.before = before;
      }

      const batch = await channel.messages.fetch(fetchParams);
      if (batch.size === 0) {
        reachedEnd = true;
        break;
      }

      const messages = Array.from(batch.values()).sort(
        (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0)
      );
      totalFetched += messages.length;

      // Track oldest and newest messages by comparing timestamps
      if (messages.length > 0) {
        const firstMsg = messages[0];
        const lastMsg = messages[messages.length - 1];
        const firstTimestamp = firstMsg.createdTimestamp ?? 0;
        const lastTimestamp = lastMsg.createdTimestamp ?? 0;

        // Update oldest message if this is older than what we have
        if (!oldestMessageTimestamp || firstTimestamp < oldestMessageTimestamp) {
          oldestMessageId = firstMsg.id;
          oldestMessageTimestamp = firstTimestamp;
        }

        // Update newest message if this is newer than what we have
        if (!newestMessageTimestamp || lastTimestamp > newestMessageTimestamp) {
          newestMessageId = lastMsg.id;
          newestMessageTimestamp = lastTimestamp;
        }
      }

      // Build memories for this batch and check if they already exist
      const batchMemories: Memory[] = [];
      let newCount = 0;
      let existingCount = 0;

      // Build all memories first
      const allMemories: Memory[] = [];
      for (const discordMessage of messages) {
        const memory = await this.buildMemoryFromMessage(discordMessage);
        if (memory?.id) {
          allMemories.push(memory);
        }
      }

      // Batch check which memories already exist (single DB query)
      if (allMemories.length > 0) {
        const memoryIds = allMemories.map((m) => m.id).filter((id): id is UUID => id !== undefined);
        const existingMemories = await this.runtime.getMemoriesByIds(memoryIds, "messages");
        const existingIdSet = new Set(existingMemories.map((m) => m.id));

        // Filter to only new memories
        for (const memory of allMemories) {
          if (memory.id && existingIdSet.has(memory.id)) {
            existingCount++;
          } else {
            newCount++;
            batchMemories.push(memory);
          }
        }
      }

      // Determine HIT (all existed) or MISS (had new messages)
      const hitMiss = existingCount > 0 && newCount === 0 ? "HIT" : newCount > 0 ? "MISS" : "EMPTY";

      // Process batch via callback or persist and accumulate
      if (options.onBatch) {
        // Caller handles persistence via callback
        const shouldContinue = await options.onBatch(batchMemories, {
          page: pagesProcessed,
          totalFetched,
          totalStored: totalStored + batchMemories.length,
        });

        // Assume caller persists all memories when using onBatch
        totalStored += batchMemories.length;

        if (shouldContinue === false) {
          this.runtime.logger.debug(
            {
              src: "plugin:discord",
              agentId: this.runtime.agentId,
              channelId,
              page: pagesProcessed,
            },
            "Batch handler requested early stop"
          );
          break;
        }
      } else {
        // Ensure entity connections exist before persisting (prevents FK constraint failures)
        await this.ensureConnectionsForMessages(messages, ensuredEntityIds);

        // Persist memories to database, only count successfully persisted
        const successfullyPersisted: Memory[] = [];
        for (const memory of batchMemories) {
          try {
            await this.runtime.createMemory(memory, "messages");
            successfullyPersisted.push(memory);
          } catch (error) {
            this.runtime.logger.warn(
              {
                src: "plugin:discord",
                agentId: this.runtime.agentId,
                memoryId: memory.id,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to persist memory during backfill"
            );
          }
        }
        allMessages.push(...successfullyPersisted);
        totalStored += successfullyPersisted.length;
      }
      consecutiveNoNew = batchMemories.length === 0 ? consecutiveNoNew + 1 : 0;

      // Save state after every page so we can resume if interrupted
      const incrementalState: ChannelSpiderState = {
        channelId,
        oldestMessageId,
        newestMessageId,
        oldestMessageTimestamp,
        newestMessageTimestamp,
        lastSpideredAt: Date.now(),
        fullyBackfilled: false, // Not complete yet, still in progress
      };
      await this.saveSpiderState(incrementalState);

      // Debug log for each page
      const oldestDate = oldestMessageTimestamp
        ? new Date(oldestMessageTimestamp).toISOString().split("T")[0]
        : "?";
      const newestDate = newestMessageTimestamp
        ? new Date(newestMessageTimestamp).toISOString().split("T")[0]
        : "?";
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      this.runtime.logger.debug(
        `#${channelName}: Page ${pagesProcessed} [${hitMiss}], ${messages.length} msgs fetched (${newCount} new, ${existingCount} existing), ${batchMemories.length} stored, ${totalFetched} total fetched, ${totalStored} total stored, dates ${oldestDate} to ${newestDate} (${elapsedSec}s)`
      );

      // Log progress every 10 pages (1000 messages) or on first page at info level
      if (pagesProcessed === 1 || pagesProcessed % 10 === 0) {
        this.runtime.logger.info(
          `#${channelName}: Page ${pagesProcessed}, ${totalFetched} msgs fetched, ${totalStored} stored, dates ${oldestDate} to ${newestDate} (${elapsedSec}s)`
        );
      }

      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          channelId,
          batchSize: batch.size,
          storedThisBatch: batchMemories.length,
          totalStored,
          totalFetched,
          page: pagesProcessed,
        },
        "Processed channel history batch"
      );

      // Check stop conditions
      if (options.limit && totalFetched >= options.limit) {
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelId,
            limit: options.limit,
          },
          "Reached fetch limit"
        );
        break;
      }

      // Check if we've reached the actual end of channel history
      if (batch.size < 100) {
        reachedEnd = true;
        break;
      }

      // Stop if we've hit 3 consecutive pages of existing messages (optimization)
      // But DON'T mark as fullyBackfilled - we may have more older history to fetch
      if (consecutiveNoNew >= 3) {
        this.runtime.logger.debug(
          { src: "plugin:discord", agentId: this.runtime.agentId, channelId },
          "Stopping backfill: 3 consecutive pages of existing messages (will resume from oldest on next run)"
        );
        break;
      }

      // Update pagination cursor using the sorted messages array (oldest-first)
      // This ensures correct cursor advancement regardless of Discord's response order
      if (after) {
        // Forward pagination: advance to the newest message we've processed
        // Use sorted array: messages[last] = newest after sorting by timestamp
        const lastMessage = messages[messages.length - 1];
        after = lastMessage?.id;
      } else {
        // Backward pagination: advance to the oldest message we've processed
        // Use sorted array: messages[0] = oldest after sorting by timestamp
        const firstMessage = messages[0];
        before = firstMessage?.id;
      }

      // Rate limiting
      await this.delay(250);
    }

    // Update spider state
    const newState: ChannelSpiderState = {
      channelId,
      oldestMessageId,
      newestMessageId,
      oldestMessageTimestamp,
      newestMessageTimestamp,
      lastSpideredAt: Date.now(),
      // Preserve fullyBackfilled if already true, or mark as backfilled if we reached the end going backwards
      fullyBackfilled: spiderState?.fullyBackfilled || (reachedEnd && !after),
    };
    await this.saveSpiderState(newState);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const dateRange =
      oldestMessageTimestamp && newestMessageTimestamp
        ? `${new Date(oldestMessageTimestamp).toISOString().split("T")[0]} to ${new Date(newestMessageTimestamp).toISOString().split("T")[0]}`
        : "no messages";
    const status = newState.fullyBackfilled ? "✓ complete" : "↻ partial";
    this.runtime.logger.info(
      `#${channelName}: ${status} - ${totalFetched} msgs, ${pagesProcessed} pages, ${dateRange} (${elapsedSec}s)`
    );

    return {
      messages: allMessages,
      stats: {
        fetched: totalFetched,
        stored: totalStored,
        pages: pagesProcessed,
        fullyBackfilled: newState.fullyBackfilled,
      },
    };
  }

  /**
   * Builds a Memory object from a Discord Message.
   * This is a reusable helper for converting Discord messages to ElizaOS Memory format.
   *
   * @param {Message} message - The Discord message to convert
   * @param {Object} options - Optional parameters
   * @param {string} options.processedContent - Pre-processed text content (if already processed, to avoid double-processing)
   * @param {Media[]} options.processedAttachments - Pre-processed attachments (if already processed)
   * @param {Object} options.extraContent - Additional content fields to merge into the memory content
   * @param {Object} options.extraMetadata - Additional metadata fields to merge into the memory metadata
   * @returns {Promise<Memory | null>} The Memory object, or null if the message is invalid
   */
  public async buildMemoryFromMessage(
    message: Message,
    options?: {
      processedContent?: string;
      processedAttachments?: Media[];
      extraContent?: Record<string, unknown>;
      extraMetadata?: Record<string, unknown>;
    }
  ): Promise<Memory | null> {
    if (!message.author || !message.channel) {
      return null;
    }

    const entityId = createUniqueUuid(this.runtime, message.author.id);
    const roomId = createUniqueUuid(this.runtime, message.channel.id);
    const channel = message.channel;
    const channelType = await this.getChannelType(channel as Channel);
    const channelGuild = "guild" in channel ? channel.guild : null;
    const serverId = channelGuild?.id ? channelGuild.id : (message.guild?.id ?? message.channel.id);
    const worldId = serverId ? createUniqueUuid(this.runtime, serverId) : this.runtime.agentId;

    // Use pre-processed content if provided, otherwise process now
    let textContent: string;
    let attachments: Media[];

    const optionsProcessedContent = options?.processedContent;
    const optionsProcessedAttachments = options?.processedAttachments;
    if (optionsProcessedContent !== undefined || optionsProcessedAttachments !== undefined) {
      textContent = options.processedContent || " ";
      attachments = options.processedAttachments || [];
    } else {
      const processed = this.messageManager
        ? await this.messageManager.processMessage(message)
        : { processedContent: message.content, attachments: [] };

      const processedContent = processed?.processedContent;
      textContent =
        processedContent && processedContent.trim().length > 0
          ? processedContent
          : message.content || " ";
      attachments = processed?.attachments ?? [];
    }

    const metadata = {
      type: "custom" as const,
      entityName:
        (message.member &&
        "displayName" in message.member &&
        typeof message.member.displayName === "string"
          ? message.member.displayName
          : undefined) ??
        ("globalName" in message.author && typeof message.author.globalName === "string"
          ? message.author.globalName
          : undefined) ??
        message.author.username,
      fromBot: message.author.bot,
      fromId: message.author.id,
      sourceId: entityId,
      // Raw Discord IDs for cross-agent correlation (not transformed by createUniqueUuid)
      discordMessageId: message.id,
      discordChannelId: message.channel.id,
      discordServerId: (() => {
        const messageChannelGuild = "guild" in message.channel ? message.channel.guild : null;
        return messageChannelGuild?.id || message.guild?.id || undefined;
      })(),
      tags: [] as string[],
      ...(options?.extraMetadata ? options.extraMetadata : {}),
    };

    const memory: Memory = {
      id: createUniqueUuid(this.runtime, message.id),
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: textContent || " ",
        attachments,
        source: "discord",
        channelType,
        url: message.url,
        inReplyTo: message.reference?.messageId
          ? createUniqueUuid(this.runtime, message.reference.messageId)
          : undefined,
        ...(options?.extraContent ? options.extraContent : {}),
      },
      metadata: metadata as unknown as Memory["metadata"],
      createdAt: message.createdTimestamp ?? Date.now(),
      worldId,
    };

    return memory;
  }

  /**
   * Ensures entity connections exist for a batch of Discord messages using batch API.
   * This should be called before persisting memories to avoid FK constraint failures.
   *
   * @param {Message[]} messages - The Discord messages to ensure connections for
   * @param {Set<string>} ensuredEntityIds - Optional set of already-ensured entity IDs (for caching across batches)
   * @returns {Promise<void>}
   */
  private async ensureConnectionsForMessages(
    messages: Message[],
    ensuredEntityIds: Set<string> = new Set()
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    // Collect unique authors that haven't been ensured yet
    const uniqueAuthors = new Map<string, Message>();
    for (const message of messages) {
      if (message.author && !ensuredEntityIds.has(message.author.id)) {
        uniqueAuthors.set(message.author.id, message);
      }
    }

    if (uniqueAuthors.size === 0) {
      return;
    }

    try {
      // Use the first message to determine room and world (all messages are from the same channel)
      const firstMessage = messages[0];
      const channelType = await this.getChannelType(firstMessage.channel as Channel);
      const firstMessageChannelGuild =
        "guild" in firstMessage.channel ? firstMessage.channel.guild : null;
      const serverId = firstMessageChannelGuild?.id
        ? firstMessageChannelGuild.id
        : (firstMessage.guild?.id ?? firstMessage.channel.id);
      const worldId = serverId ? createUniqueUuid(this.runtime, serverId) : this.runtime.agentId;

      // Build entities array for batch API
      const entities = Array.from(uniqueAuthors.entries()).map(([authorId, message]) => {
        const userName = message.author.username;
        const name =
          (message.member &&
          "displayName" in message.member &&
          typeof message.member.displayName === "string"
            ? message.member.displayName
            : undefined) ??
          ("globalName" in message.author && typeof message.author.globalName === "string"
            ? message.author.globalName
            : undefined) ??
          userName;
        return {
          id: createUniqueUuid(this.runtime, authorId),
          names: [userName, name].filter((n): n is string => typeof n === "string" && n.length > 0),
          metadata: {
            originalId: authorId,
            username: userName,
            displayName: name,
          },
          agentId: this.runtime.agentId,
        };
      });

      // Build rooms array (single room for history fetch)
      const rooms = [
        {
          id: createUniqueUuid(this.runtime, firstMessage.channel.id),
          channelId: firstMessage.channel.id,
          type: channelType,
          source: "discord",
        },
      ];

      // Build world object
      // For DMs, include channel ID in name for observability when debugging multiple DM worlds
      const world: WorldCompat = {
        id: worldId,
        messageServerId: stringToUuid(serverId),
        name: firstMessage.guild?.name ?? `DM-${firstMessage.channel.id}`,
        agentId: this.runtime.agentId,
      };

      // Use batch API for efficient database operations
      await this.runtime.ensureConnections(entities, rooms, "discord", world);

      // Mark all authors as ensured
      for (const authorId of uniqueAuthors.keys()) {
        ensuredEntityIds.add(authorId);
      }
    } catch (error) {
      // Log but don't fail - the memory creation will fail with a clearer error if needed
      this.runtime.logger.debug(
        {
          src: "plugin:discord",
          agentId: this.runtime.agentId,
          authorCount: uniqueAuthors.size,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to ensure batch connections for message authors during history fetch"
      );
    }
  }

  /**
   * Stops the Discord service and cleans up resources.
   * Implements the abstract method from the Service class.
   */
  public async stop(): Promise<void> {
    this.runtime.logger.info("Stopping Discord service");
    this.timeouts.forEach(clearTimeout); // Clear any pending timeouts
    this.timeouts = [];
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.runtime.logger.info("Discord client destroyed");
    }
    // Additional cleanup if needed (e.g., voice manager)
    if (this.voiceManager) {
      // Assuming voiceManager has a stop or cleanup method
      // await this.voiceManager.stop();
    }
    this.runtime.logger.info("Discord service stopped");
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

      case DiscordChannelType.GroupDM:
        return ChannelType.DM; // Group DMs treated as DM

      case DiscordChannelType.GuildText:
      case DiscordChannelType.GuildNews: // Announcement channels
      case DiscordChannelType.PublicThread:
      case DiscordChannelType.PrivateThread:
      case DiscordChannelType.AnnouncementThread:
      case DiscordChannelType.GuildForum: // Forum channels
        return ChannelType.GROUP;

      case DiscordChannelType.GuildVoice:
      case DiscordChannelType.GuildStageVoice: // Stage channels
        return ChannelType.VOICE_GROUP;

      default:
        // Fallback for any unrecognized channel types
        this.runtime.logger.debug(
          {
            src: "plugin:discord",
            agentId: this.runtime.agentId,
            channelType: channel.type,
          },
          "Unknown channel type, defaulting to GROUP"
        );
        return ChannelType.GROUP;
    }
  }
}

export default DiscordService;

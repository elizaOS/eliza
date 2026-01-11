import type {
  ChannelType,
  Character,
  EntityPayload,
  EventPayload,
  IAgentRuntime,
  Media,
  Memory,
  MessagePayload,
  WorldPayload,
} from "@elizaos/core";
import type {
  Channel,
  Client as DiscordJsClient,
  Guild,
  GuildMember,
  Interaction,
  Message,
  MessageReaction,
  User,
  VoiceState,
} from "discord.js";

/**
 * Discord-specific event types
 */
export enum DiscordEventTypes {
  // Message events (prefixed versions of core events)
  MESSAGE_RECEIVED = "DISCORD_MESSAGE_RECEIVED",
  MESSAGE_SENT = "DISCORD_MESSAGE_SENT",

  // slash commands event
  SLASH_COMMAND = "DISCORD_SLASH_COMMAND",
  MODAL_SUBMIT = "DISCORD_MODAL_SUBMIT",

  // Reaction events
  REACTION_RECEIVED = "DISCORD_REACTION_RECEIVED",
  REACTION_REMOVED = "DISCORD_REACTION_REMOVED",

  // Server/World events
  WORLD_JOINED = "DISCORD_WORLD_JOINED",
  WORLD_CONNECTED = "DISCORD_SERVER_CONNECTED",

  // User/Entity events
  // Note: ENTITY_JOINED is emitted when a user joins a Discord guild (server).
  // This is different from the core EventType.ENTITY_JOINED which requires a roomId.
  // In Discord terms: guild membership != channel membership. Users join the "world"
  // (guild) but only join specific "rooms" (channels) when they first interact there.
  // Use this event for Discord-specific handling like welcome messages or role checks.
  ENTITY_JOINED = "DISCORD_USER_JOINED",
  ENTITY_LEFT = "DISCORD_USER_LEFT",

  // Voice events
  VOICE_STATE_CHANGED = "DISCORD_VOICE_STATE_CHANGED",

  // Permission audit events
  CHANNEL_PERMISSIONS_CHANGED = "DISCORD_CHANNEL_PERMISSIONS_CHANGED",
  ROLE_PERMISSIONS_CHANGED = "DISCORD_ROLE_PERMISSIONS_CHANGED",
  MEMBER_ROLES_CHANGED = "DISCORD_MEMBER_ROLES_CHANGED",
  ROLE_CREATED = "DISCORD_ROLE_CREATED",
  ROLE_DELETED = "DISCORD_ROLE_DELETED",

  // Channel filter events
  LISTEN_CHANNEL_MESSAGE = "DISCORD_LISTEN_CHANNEL_MESSAGE",
  NOT_IN_CHANNELS_MESSAGE = "DISCORD_NOT_IN_CHANNELS_MESSAGE",
}

/**
 * Discord-specific message received payload
 */
export interface DiscordMessageReceivedPayload extends MessagePayload {
  /** The original Discord message */
  originalMessage: Message;
}

/**
 * Discord-specific message sent payload
 */
export interface DiscordMessageSentPayload extends MessagePayload {
  /** The original Discord messages sent */
  originalMessages: Message[];
}

/**
 * Discord-specific reaction received payload
 */
export interface DiscordReactionPayload extends MessagePayload {
  /** The original Discord reaction */
  originalReaction: MessageReaction;
  /** The user who reacted */
  user: User;
}
/**
 * Discord-specific server payload
 */
export interface DiscordServerPayload extends WorldPayload {
  /** The original Discord guild */
  server: Guild;
}

/**
 * Discord-specific user joined payload.
 *
 * Emitted via `DiscordEventTypes.ENTITY_JOINED` when a user joins a Discord guild.
 *
 * **Important:** This event represents guild membership, not room/channel membership.
 * The payload contains `worldId` (the guild) but no `roomId` because the user hasn't
 * joined any specific channel yet. The entity will be synced to specific rooms when
 * they first interact (send a message, join voice, etc.).
 *
 * Use this event for Discord-specific handling like:
 * - Sending welcome messages
 * - Assigning default roles
 * - Moderation checks (account age, etc.)
 * - Logging new member joins
 */
export interface DiscordUserJoinedPayload extends EntityPayload {
  /** The original Discord.js GuildMember object for full Discord API access */
  member: GuildMember;
}

/**
 * Discord-specific user left payload
 */
export interface DiscordUserLeftPayload extends EntityPayload {
  /** The original Discord guild member */
  member: GuildMember;
}

/**
 * Discord-specific voice state changed payload
 */
export interface DiscordVoiceStateChangedPayload {
  /** The original Discord voice state */
  voiceState: VoiceState;
}

/**
 * Payload for listen channel message events
 */
export interface DiscordListenChannelPayload {
  /** Runtime instance */
  runtime: IAgentRuntime;
  /** The message that was received */
  message: Memory;
  /** Source identifier for the event */
  source: string;
}

/**
 * Payload for not-in-channels message events
 */
export interface DiscordNotInChannelsPayload {
  /** Runtime instance */
  runtime: IAgentRuntime;
  /** The message that was received */
  message: Message;
  /** Source identifier for the event */
  source: string;
}

// ============================================================================
// Permission Audit Types
// ============================================================================

/**
 * Permission state in an overwrite or role
 */
export type PermissionState = "ALLOW" | "DENY" | "NEUTRAL";

/**
 * A single permission change
 */
export interface PermissionDiff {
  /** The permission name (e.g., 'ManageMessages', 'Administrator') */
  permission: string;
  /** Previous state */
  oldState: PermissionState;
  /** New state */
  newState: PermissionState;
}

/**
 * Information about who made a change, from audit logs
 */
export interface AuditInfo {
  /** Discord user ID of the executor */
  executorId: string;
  /** Discord username#discriminator or username of the executor */
  executorTag: string;
  /** Reason provided for the action, if any */
  reason: string | null;
}

/**
 * Payload for DISCORD_CHANNEL_PERMISSIONS_CHANGED event
 * Emitted when channel permission overwrites are created, updated, or deleted
 */
export interface ChannelPermissionsChangedPayload extends EventPayload {
  /** Guild information */
  guild: { id: string; name: string };
  /** Channel where permissions changed */
  channel: { id: string; name: string };
  /** Target of the permission overwrite (role or user) */
  target: { type: "role" | "user"; id: string; name: string };
  /** What happened to the overwrite */
  action: "CREATE" | "UPDATE" | "DELETE";
  /** List of permission changes */
  changes: PermissionDiff[];
  /** Audit log info (null if unavailable) */
  audit: AuditInfo | null;
}

/**
 * Payload for DISCORD_ROLE_PERMISSIONS_CHANGED event
 * Emitted when a role's permissions are modified
 */
export interface RolePermissionsChangedPayload extends EventPayload {
  /** Guild information */
  guild: { id: string; name: string };
  /** Role that was modified */
  role: { id: string; name: string };
  /** List of permission changes */
  changes: PermissionDiff[];
  /** Audit log info (null if unavailable) */
  audit: AuditInfo | null;
}

/**
 * Payload for DISCORD_MEMBER_ROLES_CHANGED event
 * Emitted when roles are added or removed from a member
 */
export interface MemberRolesChangedPayload extends EventPayload {
  /** Guild information */
  guild: { id: string; name: string };
  /** Member whose roles changed */
  member: { id: string; tag: string };
  /** Roles that were added */
  added: Array<{ id: string; name: string; permissions: string[] }>;
  /** Roles that were removed */
  removed: Array<{ id: string; name: string; permissions: string[] }>;
  /** Audit log info (null if unavailable) */
  audit: AuditInfo | null;
}

/**
 * Payload for DISCORD_ROLE_CREATED and DISCORD_ROLE_DELETED events
 */
export interface RoleLifecyclePayload extends EventPayload {
  /** Guild information */
  guild: { id: string; name: string };
  /** Role that was created or deleted */
  role: { id: string; name: string; permissions: string[] };
  /** Audit log info (null if unavailable) */
  audit: AuditInfo | null;
}

/**
 * Discord slash command definition with hybrid permission system.
 *
 * This interface combines Discord's native permission features with ElizaOS-specific
 * controls to provide a flexible, developer-friendly API for command permissions.
 *
 * ## Design Philosophy
 * - **Zero config = works everywhere** (default behavior)
 * - **Simple flags** for common use cases (guild-only, admin-only, etc.)
 * - **Native Discord features** where possible (leverages Discord's permission system)
 * - **Programmatic control** for advanced scenarios (custom validators)
 *
 * ## Permission Layers
 *
 * Commands go through multiple permission checks in this order:
 * 1. **Discord native checks** (handled by Discord before interaction fires):
 *    - `requiredPermissions`: User must have these Discord permissions
 *    - `guildOnly`/`contexts`: Command availability in guilds vs DMs
 * 2. **ElizaOS channel whitelist** (CHANNEL_IDS env var):
 *    - If set, commands only work in whitelisted channels
 *    - Unless `bypassChannelWhitelist: true` is set
 * 3. **Custom validator** (if provided):
 *    - Runs after all other checks
 *    - Full programmatic control for complex logic
 *
 * @example
 * // Default: works everywhere
 * { name: 'help', description: 'Show help' }
 *
 * @example
 * // Guild-only command
 * { name: 'serverinfo', description: 'Show server info', guildOnly: true }
 *
 * @example
 * // Requires Discord permission
 * {
 *   name: 'config',
 *   description: 'Configure bot',
 *   requiredPermissions: PermissionFlagsBits.ManageGuild
 * }
 *
 * @example
 * // Bypasses channel whitelist (works in all channels)
 * {
 *   name: 'dumpchannel',
 *   description: 'Export channel',
 *   bypassChannelWhitelist: true
 * }
 *
 * @example
 * // Advanced: custom validation
 * {
 *   name: 'admin',
 *   description: 'Admin command',
 *   validator: async (interaction, runtime) => {
 *     // Custom logic here
 *     return interaction.user.id === runtime.getSetting('ADMIN_USER_ID');
 *   }
 * }
 */
export interface DiscordSlashCommand {
  /** Command name (must be lowercase, no spaces) */
  name: string;

  /** Command description shown in Discord UI */
  description: string;

  /** Command options/parameters */
  options?: Array<{
    name: string;
    type: number;
    description: string;
    required?: boolean;
    channel_types?: number[];
  }>;

  // ==================== Simple Permission Flags ====================

  /**
   * If true, command only works in guilds (not DMs).
   * Transformed to Discord's `contexts: [0]` during registration.
   *
   * Use this for commands that need server context (e.g., server info, moderation).
   */
  guildOnly?: boolean;

  /**
   * If true, command bypasses CHANNEL_IDS whitelist restrictions.
   *
   * Use this for utility commands that should work everywhere regardless of
   * channel restrictions (e.g., help, export, diagnostics).
   *
   * Note: This is an ElizaOS-specific feature, not a Discord native feature.
   * Discord handles this via Server Settings > Integrations UI, but we provide
   * programmatic control for better developer experience.
   */
  bypassChannelWhitelist?: boolean;

  // ==================== Discord Native Permissions ====================

  /**
   * Discord permission bitfield required to use this command.
   * Transformed to `default_member_permissions` during registration.
   *
   * Common values (from Discord.js PermissionFlagsBits):
   * - `ManageGuild`: Server settings
   * - `ManageChannels`: Channel management
   * - `ManageMessages`: Delete messages
   * - `BanMembers`: Ban users
   * - `KickMembers`: Kick users
   * - `ModerateMembers`: Timeout users
   * - `ManageRoles`: Role management
   * - `Administrator`: Full access
   *
   * Set to `null` to explicitly allow everyone (overrides Discord's defaults).
   *
   * @example
   * requiredPermissions: PermissionFlagsBits.ManageGuild
   *
   * @example
   * // Multiple permissions (combine with bitwise OR)
   * requiredPermissions: PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ModerateMembers
   */
  requiredPermissions?: bigint | string | null;

  // ==================== Advanced Options ====================

  /**
   * Raw Discord contexts array. Overrides `guildOnly` if provided.
   * - 0 = Guild (server channels)
   * - 1 = BotDM (DMs with the bot)
   * - 2 = PrivateChannel (group DMs)
   *
   * Most developers should use `guildOnly` instead of this.
   */
  contexts?: number[];

  /**
   * If provided, register this command only in specific guilds (servers).
   * Otherwise, command is registered globally and appears in all guilds.
   *
   * Guild-specific commands update instantly, while global commands can take
   * up to 1 hour to propagate. Use this for testing or server-specific features.
   *
   * @example
   * guildIds: ['123456789012345678', '987654321098765432']
   */
  guildIds?: string[];

  /**
   * Custom validation function for advanced permission logic.
   *
   * Called after Discord's native checks and channel whitelist checks.
   * Return `true` to allow the command, `false` to block it.
   *
   * **Important**: If your validator returns `false`, you should respond to the interaction
   * before returning to provide context to the user. If you don't respond, a generic
   * "You do not have permission to use this command." message will be sent automatically.
   *
   * This is useful for:
   * - ElizaOS-specific permission systems (when implemented)
   * - Complex business logic (e.g., rate limiting, feature flags)
   * - Dynamic permissions based on runtime state
   *
   * @param interaction - The Discord interaction object (can be used to reply/respond)
   * @param runtime - The ElizaOS runtime instance
   * @returns Promise resolving to true if command should execute, false otherwise
   *
   * @example
   * // Simple validator without custom response (uses default)
   * validator: async (interaction, runtime) => {
   *   const userId = interaction.user.id;
   *   const allowedUsersSetting = runtime.getSetting('ALLOWED_USERS');
   *   const allowedUsers = (allowedUsersSetting && typeof allowedUsersSetting === 'string' && allowedUsersSetting.split(',')) ?? [];
   *   return allowedUsers.includes(userId);
   * }
   *
   * @example
   * // Validator with custom rejection message
   * validator: async (interaction, runtime) => {
   *   const userId = interaction.user.id;
   *   const isAllowed = await checkUserPermission(userId);
   *   if (!isAllowed) {
   *     await interaction.reply({
   *       content: 'This command is only available to premium users.',
   *       ephemeral: true,
   *     });
   *     return false;
   *   }
   *   return true;
   * }
   */
  validator?: (interaction: Interaction, runtime: IAgentRuntime) => Promise<boolean>;
}

/**
 * Payload for DISCORD_REGISTER_COMMANDS event
 * Used to register slash commands from other plugins
 */
export interface DiscordRegisterCommandsPayload extends EventPayload {
  commands: DiscordSlashCommand[];
  /** @deprecated Use bypassChannelWhitelist on DiscordSlashCommand instead */
  allowAllChannels?: Record<string, boolean>;
}

/**
 * Discord-specific slash commands payload for command execution
 */
export interface DiscordSlashCommandPayload extends EventPayload {
  interaction: Interaction;
  client: DiscordJsClient;
  commands: DiscordSlashCommand[];
}

/**
 * Maps Discord event types to their payload interfaces
 */
export interface DiscordEventPayloadMap {
  [DiscordEventTypes.MESSAGE_RECEIVED]: DiscordMessageReceivedPayload;
  [DiscordEventTypes.MESSAGE_SENT]: DiscordMessageSentPayload;
  [DiscordEventTypes.REACTION_RECEIVED]: DiscordReactionPayload;
  [DiscordEventTypes.REACTION_REMOVED]: DiscordReactionPayload;
  [DiscordEventTypes.WORLD_JOINED]: DiscordServerPayload;
  [DiscordEventTypes.WORLD_CONNECTED]: DiscordServerPayload;
  [DiscordEventTypes.ENTITY_JOINED]: DiscordUserJoinedPayload;
  [DiscordEventTypes.ENTITY_LEFT]: DiscordUserLeftPayload;
  [DiscordEventTypes.SLASH_COMMAND]: DiscordSlashCommandPayload;
  [DiscordEventTypes.MODAL_SUBMIT]: DiscordSlashCommandPayload;
  [DiscordEventTypes.VOICE_STATE_CHANGED]: DiscordVoiceStateChangedPayload;
  [DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED]: ChannelPermissionsChangedPayload;
  [DiscordEventTypes.ROLE_PERMISSIONS_CHANGED]: RolePermissionsChangedPayload;
  [DiscordEventTypes.MEMBER_ROLES_CHANGED]: MemberRolesChangedPayload;
  [DiscordEventTypes.ROLE_CREATED]: RoleLifecyclePayload;
  [DiscordEventTypes.ROLE_DELETED]: RoleLifecyclePayload;
  [DiscordEventTypes.LISTEN_CHANNEL_MESSAGE]: DiscordListenChannelPayload;
  [DiscordEventTypes.NOT_IN_CHANNELS_MESSAGE]: DiscordNotInChannelsPayload;
}

/**
 * Interface representing a Discord service.
 *
 * @typedef {Object} IDiscordService
 * @property {DiscordJsClient} client - The Discord client object.
 * @property {Character} character - The character object.
 */
/**
 * Serializable JSON value type - use instead of any for JSON data
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Record type for JSON objects - use instead of Record<string, any>
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Options for building a memory from a Discord message
 */
export interface BuildMemoryFromMessageOptions {
  /** Processed message content after formatting */
  processedContent?: string;
  /** Processed attachments converted to Media objects */
  processedAttachments?: Media[];
  /** Additional content to include in the memory */
  extraContent?: JsonObject;
  /** Additional metadata to include in the memory */
  extraMetadata?: JsonObject;
}

export interface IDiscordService {
  // Allow client to be null to handle initialization failures
  client: DiscordJsClient | null;
  character: Character;
  getChannelType: (channel: Channel) => Promise<ChannelType>;
  buildMemoryFromMessage: (
    message: Message,
    options?: BuildMemoryFromMessageOptions
  ) => Promise<Memory | null>;
}

export const DISCORD_SERVICE_NAME = "discord";

export const ServiceType = {
  DISCORD: "discord",
} as const;

export interface DiscordComponentOptions {
  type: number;
  custom_id: string;
  label?: string;
  style?: number;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordComponentOptions[];
}

// maybe discord character settings makes more sense?
export interface DiscordSettings {
  allowedChannelIds?: string[];
  shouldIgnoreBotMessages?: boolean;
  shouldIgnoreDirectMessages?: boolean;
  shouldRespondOnlyToMentions?: boolean;
  //[key: string]: any; // still allows extension
}

/**
 * State tracking for channel history spider to avoid re-fetching
 */
export interface ChannelSpiderState {
  /** Discord channel ID */
  channelId: string;
  /** Oldest message ID fetched (for going further back) */
  oldestMessageId?: string;
  /** Newest message ID fetched (for catching up) */
  newestMessageId?: string;
  /** Timestamp of oldest message (for comparison) */
  oldestMessageTimestamp?: number;
  /** Timestamp of newest message (for comparison) */
  newestMessageTimestamp?: number;
  /** Timestamp of last spider run */
  lastSpideredAt: number;
  /** True if we've reached the beginning of channel history */
  fullyBackfilled: boolean;
}

/**
 * Batch handler for processing messages as they arrive during history fetch
 * @returns false to stop fetching early, void/true to continue
 */
export type BatchHandler = (
  batch: Memory[],
  stats: { page: number; totalFetched: number; totalStored: number }
) => Promise<boolean | undefined> | boolean | undefined;

/**
 * Options for fetching channel history
 */
export interface ChannelHistoryOptions {
  /** Maximum number of messages to fetch (default: unlimited) */
  limit?: number;
  /** Force re-fetch, ignoring spider state */
  force?: boolean;
  /** Callback to process each batch of messages as they arrive */
  onBatch?: BatchHandler;
  /** Start fetching before this message ID */
  before?: string;
  /** Start fetching after this message ID (for catching up) */
  after?: string;
}

/**
 * Result from fetching channel history
 */
export interface ChannelHistoryResult {
  /** Fetched messages (empty if onBatch was used) */
  messages: Memory[];
  /** Statistics about the fetch operation */
  stats: {
    /** Total messages fetched from Discord */
    fetched: number;
    /** Total messages stored/processed */
    stored: number;
    /** Number of pages fetched */
    pages: number;
    /** Whether the channel is now fully backfilled */
    fullyBackfilled: boolean;
  };
}

// ============================================================================
// Discord API Types (for strict typing of API responses)
// ============================================================================

/**
 * Discord API command structure for registration
 */
export interface DiscordApiCommand {
  name: string;
  description: string;
  options?: DiscordCommandOption[];
  default_member_permissions?: string | null;
  contexts?: number[];
}

/**
 * Discord command option structure
 */
export interface DiscordCommandOption {
  name: string;
  type: number;
  description: string;
  required?: boolean;
  channel_types?: number[];
}

/**
 * User selection state for interactive components
 */
export interface UserSelectionState {
  [key: string]: string | number | boolean | string[];
}

/**
 * Discord message send options
 */
export interface DiscordMessageSendOptions {
  content: string;
  reply?: {
    messageReference: string;
  };
  files?: Array<{ attachment: Buffer | string; name: string }>;
  components?: DiscordActionRow[];
}

// ============================================================================
// Error Types (for fail-fast error handling)
// ============================================================================

/**
 * Base error class for Discord plugin errors
 */
export class DiscordPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "DiscordPluginError";
  }
}

/**
 * Error thrown when Discord service is not initialized
 */
export class DiscordServiceNotInitializedError extends DiscordPluginError {
  constructor() {
    super("Discord service is not initialized", "SERVICE_NOT_INITIALIZED");
    this.name = "DiscordServiceNotInitializedError";
  }
}

/**
 * Error thrown when Discord client is not available
 */
export class DiscordClientNotAvailableError extends DiscordPluginError {
  constructor() {
    super("Discord client is not available", "CLIENT_NOT_AVAILABLE");
    this.name = "DiscordClientNotAvailableError";
  }
}

/**
 * Error thrown when required configuration is missing
 */
export class DiscordConfigurationError extends DiscordPluginError {
  constructor(missingConfig: string) {
    super(`Missing required configuration: ${missingConfig}`, "MISSING_CONFIG");
    this.name = "DiscordConfigurationError";
  }
}

/**
 * Error thrown when a Discord API call fails
 */
export class DiscordApiError extends DiscordPluginError {
  constructor(
    message: string,
    public readonly apiErrorCode?: number
  ) {
    super(message, "API_ERROR");
    this.name = "DiscordApiError";
  }
}

// ============================================================================
// Validation Types (for strong input validation)
// ============================================================================

/**
 * Validated Discord snowflake ID (string that matches Discord ID format)
 */
export type DiscordSnowflake = string & {
  readonly __brand: "DiscordSnowflake";
};

/**
 * Validates and returns a Discord snowflake ID
 * @throws Error if the ID is not a valid snowflake
 */
export function validateSnowflake(id: string): DiscordSnowflake {
  if (!/^\d{17,19}$/.test(id)) {
    throw new DiscordPluginError(`Invalid Discord snowflake ID: ${id}`, "INVALID_SNOWFLAKE");
  }
  return id as DiscordSnowflake;
}

/**
 * Checks if a string is a valid Discord snowflake ID
 */
export function isValidSnowflake(id: string): id is DiscordSnowflake {
  return /^\d{17,19}$/.test(id);
}

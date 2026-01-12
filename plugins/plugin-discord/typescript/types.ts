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
  MESSAGE_RECEIVED = "DISCORD_MESSAGE_RECEIVED",
  MESSAGE_SENT = "DISCORD_MESSAGE_SENT",
  SLASH_COMMAND = "DISCORD_SLASH_COMMAND",
  MODAL_SUBMIT = "DISCORD_MODAL_SUBMIT",
  REACTION_RECEIVED = "DISCORD_REACTION_RECEIVED",
  REACTION_REMOVED = "DISCORD_REACTION_REMOVED",
  WORLD_JOINED = "DISCORD_WORLD_JOINED",
  WORLD_CONNECTED = "DISCORD_SERVER_CONNECTED",
  ENTITY_JOINED = "DISCORD_USER_JOINED",
  ENTITY_LEFT = "DISCORD_USER_LEFT",
  VOICE_STATE_CHANGED = "DISCORD_VOICE_STATE_CHANGED",
  CHANNEL_PERMISSIONS_CHANGED = "DISCORD_CHANNEL_PERMISSIONS_CHANGED",
  ROLE_PERMISSIONS_CHANGED = "DISCORD_ROLE_PERMISSIONS_CHANGED",
  MEMBER_ROLES_CHANGED = "DISCORD_MEMBER_ROLES_CHANGED",
  ROLE_CREATED = "DISCORD_ROLE_CREATED",
  ROLE_DELETED = "DISCORD_ROLE_DELETED",
  LISTEN_CHANNEL_MESSAGE = "DISCORD_LISTEN_CHANNEL_MESSAGE",
  NOT_IN_CHANNELS_MESSAGE = "DISCORD_NOT_IN_CHANNELS_MESSAGE",
}

export interface DiscordMessageReceivedPayload extends MessagePayload {
  originalMessage: Message;
}

export interface DiscordMessageSentPayload extends MessagePayload {
  originalMessages: Message[];
}

export interface DiscordReactionPayload extends MessagePayload {
  originalReaction: MessageReaction;
  user: User;
}

export interface DiscordServerPayload extends WorldPayload {
  server: Guild;
}

export interface DiscordUserJoinedPayload extends EntityPayload {
  member: GuildMember;
}

export interface DiscordUserLeftPayload extends EntityPayload {
  member: GuildMember;
}

export interface DiscordVoiceStateChangedPayload {
  voiceState: VoiceState;
}

export interface DiscordListenChannelPayload {
  runtime: IAgentRuntime;
  message: Memory;
  source: string;
}

export interface DiscordNotInChannelsPayload {
  runtime: IAgentRuntime;
  message: Message;
  source: string;
}

export type PermissionState = "ALLOW" | "DENY" | "NEUTRAL";

export interface PermissionDiff {
  permission: string;
  oldState: PermissionState;
  newState: PermissionState;
}

export interface AuditInfo {
  executorId: string;
  executorTag: string;
  reason: string | null;
}

export interface ChannelPermissionsChangedPayload extends EventPayload {
  guild: { id: string; name: string };
  channel: { id: string; name: string };
  target: { type: "role" | "user"; id: string; name: string };
  action: "CREATE" | "UPDATE" | "DELETE";
  changes: PermissionDiff[];
  audit: AuditInfo | null;
}

export interface RolePermissionsChangedPayload extends EventPayload {
  guild: { id: string; name: string };
  role: { id: string; name: string };
  changes: PermissionDiff[];
  audit: AuditInfo | null;
}

export interface MemberRolesChangedPayload extends EventPayload {
  guild: { id: string; name: string };
  member: { id: string; tag: string };
  added: Array<{ id: string; name: string; permissions: string[] }>;
  removed: Array<{ id: string; name: string; permissions: string[] }>;
  audit: AuditInfo | null;
}

export interface RoleLifecyclePayload extends EventPayload {
  guild: { id: string; name: string };
  role: { id: string; name: string; permissions: string[] };
  audit: AuditInfo | null;
}

export interface DiscordSlashCommand {
  name: string;
  description: string;
  options?: Array<{
    name: string;
    type: number;
    description: string;
    required?: boolean;
    channel_types?: number[];
  }>;
  guildOnly?: boolean;
  bypassChannelWhitelist?: boolean;
  requiredPermissions?: bigint | string | null;
  contexts?: number[];
  guildIds?: string[];
  validator?: (interaction: Interaction, runtime: IAgentRuntime) => Promise<boolean>;
}

export interface DiscordRegisterCommandsPayload extends EventPayload {
  commands: DiscordSlashCommand[];
}

export interface DiscordSlashCommandPayload extends EventPayload {
  interaction: Interaction;
  client: DiscordJsClient;
  commands: DiscordSlashCommand[];
}

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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface BuildMemoryFromMessageOptions {
  processedContent?: string;
  processedAttachments?: Media[];
  extraContent?: JsonObject;
  extraMetadata?: JsonObject;
}

export interface IDiscordService {
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

export interface DiscordSettings {
  allowedChannelIds?: string[];
  shouldIgnoreBotMessages?: boolean;
  shouldIgnoreDirectMessages?: boolean;
  shouldRespondOnlyToMentions?: boolean;
}

export interface ChannelSpiderState {
  channelId: string;
  oldestMessageId?: string;
  newestMessageId?: string;
  oldestMessageTimestamp?: number;
  newestMessageTimestamp?: number;
  lastSpideredAt: number;
  fullyBackfilled: boolean;
}

export type BatchHandler = (
  batch: Memory[],
  stats: { page: number; totalFetched: number; totalStored: number }
) => Promise<boolean | undefined> | boolean | undefined;

export interface ChannelHistoryOptions {
  limit?: number;
  force?: boolean;
  onBatch?: BatchHandler;
  before?: string;
  after?: string;
}

export interface ChannelHistoryResult {
  messages: Memory[];
  stats: {
    fetched: number;
    stored: number;
    pages: number;
    fullyBackfilled: boolean;
  };
}

export interface DiscordApiCommand {
  name: string;
  description: string;
  options?: DiscordCommandOption[];
  default_member_permissions?: string | null;
  contexts?: number[];
}

export interface DiscordCommandOption {
  name: string;
  type: number;
  description: string;
  required?: boolean;
  channel_types?: number[];
}

export interface UserSelectionState {
  [key: string]: string | number | boolean | string[];
}

export interface DiscordMessageSendOptions {
  content: string;
  reply?: {
    messageReference: string;
  };
  files?: Array<{ attachment: Buffer | string; name: string }>;
  components?: DiscordActionRow[];
}

export class DiscordPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "DiscordPluginError";
  }
}

export class DiscordServiceNotInitializedError extends DiscordPluginError {
  constructor() {
    super("Discord service is not initialized", "SERVICE_NOT_INITIALIZED");
    this.name = "DiscordServiceNotInitializedError";
  }
}

export class DiscordClientNotAvailableError extends DiscordPluginError {
  constructor() {
    super("Discord client is not available", "CLIENT_NOT_AVAILABLE");
    this.name = "DiscordClientNotAvailableError";
  }
}

export class DiscordConfigurationError extends DiscordPluginError {
  constructor(missingConfig: string) {
    super(`Missing required configuration: ${missingConfig}`, "MISSING_CONFIG");
    this.name = "DiscordConfigurationError";
  }
}

export class DiscordApiError extends DiscordPluginError {
  constructor(
    message: string,
    public readonly apiErrorCode?: number
  ) {
    super(message, "API_ERROR");
    this.name = "DiscordApiError";
  }
}

export type DiscordSnowflake = string & {
  readonly __brand: "DiscordSnowflake";
};

export function validateSnowflake(id: string): DiscordSnowflake {
  if (!/^\d{17,19}$/.test(id)) {
    throw new DiscordPluginError(`Invalid Discord snowflake ID: ${id}`, "INVALID_SNOWFLAKE");
  }
  return id as DiscordSnowflake;
}

export function isValidSnowflake(id: string): id is DiscordSnowflake {
  return /^\d{17,19}$/.test(id);
}

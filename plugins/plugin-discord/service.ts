import {
	ChannelType,
	type Character,
	type Content,
	createUniqueUuid,
	type EventPayload,
	getConnectorAdminWhitelist,
	type IAgentRuntime,
	type Media,
	type Memory,
	MemoryType,
	type MessageConnectorChatContext,
	type MessageConnectorQueryContext,
	type MessageConnectorTarget,
	type MessageConnectorUserContext,
	type Room,
	Service,
	setConnectorAdminWhitelist,
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
	AttachmentBuilder,
	type Channel,
	type Collection,
	ChannelType as DiscordChannelType,
	Client as DiscordJsClient,
	Events,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
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
import {
	DEFAULT_ACCOUNT_ID,
	listEnabledDiscordAccounts,
	normalizeAccountId,
	type ResolvedDiscordAccount,
	resolveDefaultDiscordAccountId,
	resolveDiscordAccount,
} from "./accounts";
import {
	DiscordAccountClientPool,
	type DiscordAccountClientState,
} from "./account-client-pool";
import { createCompatRuntime, type ICompatRuntime } from "./compat";
import { DISCORD_SERVICE_NAME } from "./constants";
import type { ChannelDebouncer, MessageDebouncer } from "./debouncer";
import {
	handleGuildCreate as handleGuildCreateExtracted,
	isGuildOnlyCommand,
	transformCommandToDiscordApi,
} from "./discord-commands";
import { setupDiscordEventListeners } from "./discord-events";
import {
	buildMemoryFromMessage as buildMemoryFromMessageExtracted,
	fetchChannelHistory as fetchChannelHistoryExtracted,
} from "./discord-history";
import {
	handleInteractionCreate as handleInteractionCreateExtracted,
	onReady as onReadyExtracted,
} from "./discord-interactions";
import {
	handleReactionAdd as handleReactionAddExtracted,
	handleReactionRemove as handleReactionRemoveExtracted,
} from "./discord-reactions";
import { getDiscordSettings } from "./environment";
import {
	extractDiscordOwnerUserIds,
	parseDiscordOwnerUserIds,
	resolveDiscordRuntimeEntityId,
	resolveElizaOwnerEntityId,
} from "./identity";
import { MessageManager } from "./messages";
import type {
	ChannelHistoryOptions,
	ChannelHistoryResult,
	DiscordSettings,
	DiscordSlashCommand,
	IDiscordService,
} from "./types";
import { DiscordEventTypes } from "./types";
import {
	getAttachmentFileName,
	MAX_MESSAGE_LENGTH,
	normalizeDiscordMessageText,
	splitMessage,
} from "./utils";
import { VoiceManager } from "./voice";

const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,20}$/;
type MessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0];

type ConnectorFetchMessagesParams = {
	target?: TargetInfo;
	accountId?: string;
	limit?: number;
	before?: string;
	after?: string;
	cursor?: string;
	channelId?: string;
	roomId?: UUID;
	threadId?: string;
};

type ConnectorSearchMessagesParams = ConnectorFetchMessagesParams & {
	query?: string;
	author?: string;
};

type ConnectorMessageMutationParams = {
	target?: TargetInfo;
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
	threadId?: string;
	messageId?: string;
	emoji?: string;
	remove?: boolean;
	pin?: boolean;
	text?: string;
	content?: Content;
};

type ConnectorChannelMutationParams = {
	target?: TargetInfo;
	accountId?: string;
	channelId?: string;
	roomId?: UUID;
	alias?: string;
};

type ConnectorUserLookupParams = {
	accountId?: string;
	userId?: string;
	username?: string;
	handle?: string;
	query?: string;
};

type ExtendedMessageConnectorRegistration = MessageConnectorRegistration & {
	listServers?: (context: MessageConnectorQueryContext) => Promise<World[]>;
	fetchMessages?: (
		context: MessageConnectorQueryContext,
		params: ConnectorFetchMessagesParams,
	) => Promise<Memory[]>;
	searchMessages?: (
		context: MessageConnectorQueryContext,
		params: ConnectorSearchMessagesParams,
	) => Promise<Memory[]>;
	reactHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	editHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<Memory>;
	deleteHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	pinHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	) => Promise<void>;
	joinHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	) => Promise<Room | null>;
	leaveHandler?: (
		runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	) => Promise<void>;
	getUser?: (
		runtime: IAgentRuntime,
		params: ConnectorUserLookupParams,
	) => Promise<unknown>;
};

const DISCORD_CONNECTOR_CONTEXTS = ["social", "connectors"];
const DISCORD_CONNECTOR_CAPABILITIES = [
	"send_message",
	"read_messages",
	"search_messages",
	"resolve_targets",
	"list_rooms",
	"list_servers",
	"chat_context",
	"user_context",
	"react_message",
	"edit_message",
	"delete_message",
	"pin_message",
	"join_channel",
	"leave_channel",
	"get_user",
];

function normalizeDiscordConnectorQuery(value: string): string {
	return value
		.trim()
		.replace(/^<#(\d+)>$/, "$1")
		.replace(/^<@!?(\d+)>$/, "$1")
		.replace(/^#/, "")
		.replace(/^@/, "")
		.toLowerCase();
}

function scoreDiscordConnectorMatch(
	query: string,
	id: string,
	labels: Array<string | null | undefined>,
): number {
	if (!query) {
		return 0.45;
	}
	if (id === query) {
		return 1;
	}

	let bestScore = 0;
	for (const label of labels) {
		const normalized = label?.trim().toLowerCase();
		if (!normalized) {
			continue;
		}
		if (normalized === query) {
			bestScore = Math.max(bestScore, 0.95);
		} else if (normalized.startsWith(query)) {
			bestScore = Math.max(bestScore, 0.85);
		} else if (normalized.includes(query)) {
			bestScore = Math.max(bestScore, 0.7);
		}
	}
	return bestScore;
}

function isDiscordTextTarget(channel: unknown): boolean {
	const maybeChannel = channel as {
		isTextBased?: () => boolean;
		isVoiceBased?: () => boolean;
	};
	return Boolean(
		maybeChannel?.isTextBased?.() && !maybeChannel?.isVoiceBased?.(),
	);
}

function normalizeDiscordTargetUserId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return DISCORD_SNOWFLAKE_PATTERN.test(trimmed) ? trimmed : null;
}

function extractDiscordUserIdFromMetadata(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object") {
		return null;
	}

	const record = metadata as Record<string, unknown>;
	const discord =
		record.discord && typeof record.discord === "object"
			? (record.discord as Record<string, unknown>)
			: null;

	return (
		normalizeDiscordTargetUserId(discord?.userId) ??
		normalizeDiscordTargetUserId(discord?.id) ??
		normalizeDiscordTargetUserId(record.originalId)
	);
}

function stringArraySetting(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const values = value
			.map((item) => String(item).trim())
			.filter((item) => item.length > 0);
		return values.length > 0 ? values : undefined;
	}
	if (typeof value === "string" && value.trim()) {
		const values = value
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return values.length > 0 ? values : undefined;
	}
	return undefined;
}

function accountIdFromRecord(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const accountId = (value as { accountId?: unknown }).accountId;
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

type DiscordAccountSettingsConfig = ResolvedDiscordAccount["config"] &
	Partial<DiscordSettings> & {
		allowedChannelIds?: string[];
		channelIds?: string[];
		listenChannelIds?: string[];
		dm?: {
			policy?: DiscordSettings["dmPolicy"];
			allowFrom?: Array<string | number>;
		};
	};

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
	capabilityDescription =
		"The agent is able to send and receive messages on discord";
	/**
	 * Connector account ID this service instance speaks for. Single-account
	 * env-only deployments use DEFAULT_ACCOUNT_ID. When the multi-account
	 * pool is wired in, each pool slot owns one client and one accountId.
	 */
	public accountId: string = DEFAULT_ACCOUNT_ID;
	private defaultAccountId = DEFAULT_ACCOUNT_ID;
	private readonly accountPool = new DiscordAccountClientPool();
	client: DiscordJsClient | null;
	character: Character;
	discordSettings: DiscordSettings;
	messageManager?: MessageManager;
	voiceManager?: VoiceManager;
	private messageDebouncer?: MessageDebouncer;
	private channelDebouncer?: ChannelDebouncer;
	private _loginFailed = false;
	private userSelections: Map<string, Record<string, unknown>> = new Map();
	private timeouts: ReturnType<typeof setTimeout>[] = [];
	public clientReadyPromise: Promise<void> | null = null;
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
	private ownerDiscordUserIds: Set<string> = new Set();

	// Slash command registration state. Mutated by registerSlashCommands and
	// read by onReadyExtracted via the InteractionServiceInternals contract.
	public slashCommands: DiscordSlashCommand[] = [];
	private commandRegistrationQueue: Promise<void> = Promise.resolve();
	public allowAllSlashCommands: Set<string> = new Set();

	/**
	 * Resolves owner Discord user IDs from either the explicit
	 * ELIZA_DISCORD_OWNER_USER_IDS_JSON setting or the Discord application's
	 * team/owner metadata, and registers them as Discord connector admins.
	 * Called from the extracted onReady handler once the client is ready.
	 */
	public async refreshOwnerDiscordUserIds(
		client: DiscordJsClient,
	): Promise<void> {
		const explicitSetting = this.runtime.getSetting?.(
			"ELIZA_DISCORD_OWNER_USER_IDS_JSON",
		);
		const hasExplicitSetting =
			explicitSetting !== undefined &&
			explicitSetting !== null &&
			!(typeof explicitSetting === "string" && explicitSetting.trim() === "");

		let ownerIds: string[];
		if (hasExplicitSetting) {
			ownerIds = parseDiscordOwnerUserIds(
				Array.isArray(explicitSetting)
					? explicitSetting
					: typeof explicitSetting === "string"
						? explicitSetting
						: [String(explicitSetting)],
			);
		} else {
			let application: unknown;
			try {
				application =
					client.application && typeof client.application.fetch === "function"
						? await client.application.fetch()
						: client.application;
			} catch (error) {
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to fetch Discord application — owner will not be recognized. " +
						"Set ELIZA_DISCORD_OWNER_USER_IDS_JSON to fix this.",
				);
				application = client.application;
			}
			ownerIds = [...new Set(extractDiscordOwnerUserIds(application))];
		}

		this.ownerDiscordUserIds = new Set(ownerIds);
		if (ownerIds.length === 0) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
				},
				"No Discord owner user IDs resolved — owner will not be recognized from Discord messages. " +
					"Set ELIZA_DISCORD_OWNER_USER_IDS_JSON to fix this.",
			);
			return;
		}
		const existingWhitelist = getConnectorAdminWhitelist(this.runtime);
		const nextDiscordAdmins = [
			...new Set([...(existingWhitelist.discord ?? []), ...ownerIds]),
		];
		setConnectorAdminWhitelist(this.runtime, {
			...existingWhitelist,
			discord: nextDiscordAdmins,
		});
		this.runtime.logger.info(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				ownerDiscordUserIds: ownerIds,
			},
			"Resolved Discord owner identities for canonical Eliza owner mapping",
		);
	}

	/**
	 * Registers slash commands with Discord. Called from the onReady event
	 * handler via the DISCORD_REGISTER_COMMANDS event emitted by
	 * registerBuiltinSlashCommands(). Merges incoming commands with the
	 * existing set, then pushes them to Discord both globally (for DMs) and
	 * per-guild (for instant availability).
	 */
	public async registerSlashCommands(
		commands: DiscordSlashCommand[],
		accountId?: string | null,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await state.clientReadyPromise;

		const client = state.client;
		const clientApplication = client?.application;
		if (!clientApplication) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId: state.accountId,
				},
				"Cannot register commands - Discord client application not available",
			);
			return;
		}

		if (!Array.isArray(commands) || commands.length === 0) {
			this.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId: state.accountId,
				},
				"Cannot register commands - no commands provided",
			);
			return;
		}

		for (const cmd of commands) {
			if (!cmd.name || !cmd.description) {
				this.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						accountId: state.accountId,
					},
					"Cannot register commands - invalid command (missing name or description)",
				);
				return;
			}
		}

		let registrationError: Error | null = null;
		let registrationFailed = false;

		this.commandRegistrationQueue = this.commandRegistrationQueue
			.then(async () => {
				const commandMap = new Map<string, DiscordSlashCommand>();
				for (const cmd of this.slashCommands) {
					if (cmd.name) commandMap.set(cmd.name, cmd);
				}
				for (const cmd of commands) {
					if (cmd.name) commandMap.set(cmd.name, cmd);
				}
				this.slashCommands = Array.from(commandMap.values());

				this.allowAllSlashCommands.clear();
				for (const cmd of this.slashCommands) {
					if (cmd.bypassChannelWhitelist) {
						this.allowAllSlashCommands.add(cmd.name);
					}
				}

				const generalCommands = this.slashCommands.filter(
					(cmd) => cmd.guildIds.length === 0,
				);
				const globalCommands = generalCommands.filter(
					(cmd) => !isGuildOnlyCommand(cmd),
				);
				const guildOnlyCommands = generalCommands.filter((cmd) =>
					isGuildOnlyCommand(cmd),
				);
				const targetedGuildCommands = this.slashCommands.filter(
					(cmd) => cmd.guildIds && cmd.guildIds.length > 0,
				);

				const transformedGlobalCommands = globalCommands.map((cmd) =>
					transformCommandToDiscordApi(cmd),
				);
				const transformedGuildOnlyCommands = guildOnlyCommands.map((cmd) =>
					transformCommandToDiscordApi(cmd),
				);
				const transformedAllGeneralCommands = [
					...transformedGlobalCommands,
					...transformedGuildOnlyCommands,
				];

				const clientApp = client?.application;
				if (!clientApp) {
					throw new Error("Discord client application is not available");
				}

				try {
					await clientApp.commands.set(transformedGlobalCommands);
				} catch (err) {
					this.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							accountId: state.accountId,
							error: err instanceof Error ? err.message : String(err),
						},
						"Failed to register/clear global commands",
					);
				}

				const guilds = client?.guilds.cache;
				if (guilds && transformedAllGeneralCommands.length > 0) {
					await Promise.all(
						[...guilds].map(async ([guildId, guild]) => {
							try {
								await clientApp.commands.set(
									transformedAllGeneralCommands,
									guildId,
								);
							} catch (err) {
								this.runtime.logger.warn(
									{
										src: "plugin:discord",
										agentId: this.runtime.agentId,
										accountId: state.accountId,
										guildId,
										guildName: guild.name,
										error: err instanceof Error ? err.message : String(err),
									},
									"Failed to register commands to guild",
								);
							}
						}),
					);
				}

				if (guilds && targetedGuildCommands.length > 0) {
					await Promise.all(
						targetedGuildCommands.flatMap((cmd) => {
							const transformedCmd = transformCommandToDiscordApi(cmd);
							return (cmd.guildIds ?? []).map(async (guildId) => {
								const guild = guilds.get(guildId);
								if (!guild) return;
								try {
									const fullGuild = await guild.fetch();
									const existingCommands = await fullGuild.commands.fetch();
									const existingCommand = existingCommands.find(
										(c) => c.name === cmd.name,
									);
									if (existingCommand) {
										await existingCommand.edit(
											transformedCmd as Partial<
												import("discord.js").ApplicationCommandData
											>,
										);
									} else {
										await fullGuild.commands.create(transformedCmd);
									}
								} catch (error) {
									this.runtime.logger.error(
										{
											src: "plugin:discord",
											agentId: this.runtime.agentId,
											accountId: state.accountId,
											commandName: cmd.name,
											guildId,
											error:
												error instanceof Error ? error.message : String(error),
										},
										"Failed to register targeted command in guild",
									);
								}
							});
						}),
					);
				}

				this.runtime.logger.info(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						accountId: state.accountId,
						newCommands: commands.length,
						totalCommands: this.slashCommands.length,
					},
					"Commands registered",
				);
			})
			.catch((error) => {
				registrationFailed = true;
				registrationError =
					error instanceof Error ? error : new Error(String(error));
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						accountId: state.accountId,
						error: registrationError.message,
					},
					"Error registering Discord commands",
				);
			});

		await this.commandRegistrationQueue;

		if (registrationFailed && registrationError) {
			throw registrationError;
		}
	}

	private async resolveDiscordTargetUserId(
		targetEntityId: string,
	): Promise<string | null> {
		const directId = normalizeDiscordTargetUserId(targetEntityId);
		if (directId) {
			return directId;
		}

		if (targetEntityId === resolveElizaOwnerEntityId(this.runtime)) {
			const knownOwnerUserId = this.ownerDiscordUserIds.values().next().value;
			if (typeof knownOwnerUserId === "string" && knownOwnerUserId.length > 0) {
				return knownOwnerUserId;
			}
		}

		const directEntity = this.runtime.getEntityById
			? await this.runtime.getEntityById(targetEntityId as UUID)
			: null;
		const directMetadataUserId = extractDiscordUserIdFromMetadata(
			directEntity?.metadata,
		);
		if (directMetadataUserId) {
			return directMetadataUserId;
		}

		if (typeof this.runtime.getRelationships !== "function") {
			return null;
		}

		const identityLinks = await this.runtime.getRelationships({
			entityIds: [targetEntityId as UUID],
			tags: ["identity_link"],
		});
		for (const relationship of identityLinks) {
			const metadata =
				relationship.metadata && typeof relationship.metadata === "object"
					? (relationship.metadata as Record<string, unknown>)
					: null;
			if (metadata?.status !== "confirmed") {
				continue;
			}
			const linkedEntityId =
				relationship.sourceEntityId === targetEntityId
					? relationship.targetEntityId
					: relationship.targetEntityId === targetEntityId
						? relationship.sourceEntityId
						: null;
			if (!linkedEntityId || linkedEntityId === targetEntityId) {
				continue;
			}
			const linkedEntity = this.runtime.getEntityById
				? await this.runtime.getEntityById(linkedEntityId as UUID)
				: null;
			const linkedMetadataUserId = extractDiscordUserIdFromMetadata(
				linkedEntity?.metadata,
			);
			if (linkedMetadataUserId) {
				return linkedMetadataUserId;
			}
		}

		return null;
	}

	private resolveDiscordSettingsForAccount(
		account: ResolvedDiscordAccount,
	): DiscordSettings {
		const base = getDiscordSettings(this.runtime);
		const config = account.config as DiscordAccountSettingsConfig;
		const dmAllowFrom = config.dm?.allowFrom
			?.map((value) => String(value).trim())
			.filter((value) => value.length > 0);

		return {
			...base,
			allowedChannelIds:
				stringArraySetting(config.allowedChannelIds) ??
				stringArraySetting(config.channelIds) ??
				base.allowedChannelIds,
			shouldIgnoreBotMessages:
				config.shouldIgnoreBotMessages ?? base.shouldIgnoreBotMessages,
			shouldIgnoreDirectMessages:
				config.shouldIgnoreDirectMessages ?? base.shouldIgnoreDirectMessages,
			shouldRespondOnlyToMentions:
				config.shouldRespondOnlyToMentions ??
				base.shouldRespondOnlyToMentions,
			replyToMode: config.replyToMode ?? base.replyToMode,
			dmPolicy: config.dm?.policy ?? base.dmPolicy,
			allowFrom:
				dmAllowFrom && dmAllowFrom.length > 0 ? dmAllowFrom : base.allowFrom,
			syncProfile: config.syncProfile ?? base.syncProfile,
			profileName: config.profileName ?? base.profileName,
			profileAvatar: config.profileAvatar ?? base.profileAvatar,
			autoReply: config.autoReply ?? base.autoReply,
		};
	}

	private resolveListenChannelIdsForAccount(
		account: ResolvedDiscordAccount,
	): string[] | undefined {
		return (
			stringArraySetting(
				(account.config as DiscordAccountSettingsConfig).listenChannelIds,
			) ??
			stringArraySetting(this.runtime.getSetting("DISCORD_LISTEN_CHANNEL_IDS"))
		);
	}

	private createDiscordJsClient(): DiscordJsClient {
		return new DiscordJsClient({
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
	}

	private syncLegacyDefaultAliases(
		state: DiscordAccountClientState | null,
	): void {
		this.accountId = state?.accountId ?? this.defaultAccountId;
		this.client = state?.client ?? null;
		this.discordSettings = state?.settings ?? getDiscordSettings(this.runtime);
		this.messageManager = state?.messageManager;
		this.voiceManager = state?.voiceManager;
		this.messageDebouncer = state?.messageDebouncer;
		this.channelDebouncer = state?.channelDebouncer;
		this.allowedChannelIds = state?.allowedChannelIds;
		this.dynamicChannelIds = state?.dynamicChannelIds ?? new Set();
		this.clientReadyPromise = state?.clientReadyPromise ?? null;
	}

	private getAccountState(
		accountId?: string | null,
	): DiscordAccountClientState | null {
		const requested = accountId ? normalizeAccountId(accountId) : this.defaultAccountId;
		return this.accountPool?.get?.(requested) ?? null;
	}

	private getDefaultAccountState(): DiscordAccountClientState | null {
		return this.accountPool?.getDefault?.() ?? null;
	}

	private requireAccountState(
		accountId?: string | null,
	): DiscordAccountClientState {
		const normalized = accountId ? normalizeAccountId(accountId) : this.defaultAccountId;
		const state = this.getAccountState(normalized);
		if (!state) {
			throw new Error(`Discord account is not configured: ${normalized}`);
		}
		return state;
	}

	private resolveAccountIdFromTarget(
		target?: TargetInfo | null,
		fallback?: unknown,
	): string {
		return normalizeAccountId(
			accountIdFromRecord(target) ??
				accountIdFromRecord(fallback) ??
				this.defaultAccountId,
		);
	}

	public getDefaultAccountId(): string {
		return this.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
	}

	public getAccountIds(): string[] {
		return this.accountPool?.listAccountIds?.() ?? [];
	}

	public getClient(accountId?: string | null): DiscordJsClient | null {
		const state = this.getAccountState(accountId);
		if (state?.client) {
			return state.client;
		}
		const requested = accountId
			? normalizeAccountId(accountId)
			: (this.defaultAccountId ?? DEFAULT_ACCOUNT_ID);
		const defaultAccountId = this.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
		return requested === defaultAccountId ? (this.client ?? null) : null;
	}

	public getAccountLabel(accountId?: string | null): string {
		const state = this.getAccountState(accountId);
		return state?.account.name ?? state?.accountId ?? this.defaultAccountId;
	}

	private createAccountServiceFacade(
		state: DiscordAccountClientState,
	): DiscordService {
		const parent = this;
		const facade = {
			get accountId() {
				return state.accountId;
			},
			get client() {
				return state.client;
			},
			set client(value: DiscordJsClient | null) {
				state.client = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.client = value;
				}
			},
			get runtime() {
				return parent.runtime;
			},
			get character() {
				return parent.character;
			},
			get discordSettings() {
				return state.settings;
			},
			set discordSettings(value: DiscordSettings) {
				state.settings = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.discordSettings = value;
				}
			},
			get messageManager() {
				return state.messageManager;
			},
			set messageManager(value: MessageManager | undefined) {
				state.messageManager = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.messageManager = value;
				}
			},
			get voiceManager() {
				return state.voiceManager;
			},
			set voiceManager(value: VoiceManager | undefined) {
				state.voiceManager = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.voiceManager = value;
				}
			},
			get messageDebouncer() {
				return state.messageDebouncer;
			},
			set messageDebouncer(value: MessageDebouncer | undefined) {
				state.messageDebouncer = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.messageDebouncer = value;
				}
			},
			get channelDebouncer() {
				return state.channelDebouncer;
			},
			set channelDebouncer(value: ChannelDebouncer | undefined) {
				state.channelDebouncer = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.channelDebouncer = value;
				}
			},
			get allowedChannelIds() {
				return state.allowedChannelIds;
			},
			set allowedChannelIds(value: string[] | undefined) {
				state.allowedChannelIds = value;
				if (state.accountId === parent.defaultAccountId) {
					parent.allowedChannelIds = value;
				}
			},
			get listenChannelIds() {
				return state.listenChannelIds;
			},
			get allowAllSlashCommands() {
				return parent.allowAllSlashCommands;
			},
			get slashCommands() {
				return parent.slashCommands;
			},
			set slashCommands(value: DiscordSlashCommand[]) {
				parent.slashCommands = value;
			},
			get commandRegistrationQueue() {
				return parent.commandRegistrationQueue;
			},
			set commandRegistrationQueue(value: Promise<void>) {
				parent.commandRegistrationQueue = value;
			},
			get userSelections() {
				return parent.userSelections;
			},
			get timeouts() {
				return parent.timeouts;
			},
			isChannelAllowed: (channelId: string) =>
				parent.isChannelAllowed(channelId, state.accountId),
			addAllowedChannel: (channelId: string) =>
				parent.addAllowedChannel(channelId, state.accountId),
			removeAllowedChannel: (channelId: string) =>
				parent.removeAllowedChannel(channelId, state.accountId),
			getAllowedChannels: () => parent.getAllowedChannels(state.accountId),
			resolveDiscordEntityId: (userId: string) =>
				parent.resolveDiscordEntityId(userId),
			getChannelType: (channel: Channel) => parent.getChannelType(channel),
			buildMemoryFromMessage: (
				message: Message,
				options?: {
					processedContent?: string;
					processedAttachments?: Media[];
					extraContent?: Record<string, unknown>;
					extraMetadata?: Record<string, unknown>;
				},
			) =>
				parent.buildMemoryFromMessage(message, {
					...options,
					accountId: state.accountId,
				}),
			handleInteractionCreate: (interaction: Interaction) =>
				parent.handleInteractionCreateForAccount(state.accountId, interaction),
			handleGuildCreate: (guild: Guild) => parent.handleGuildCreate(guild),
			handleGuildMemberAdd: (member: GuildMember) =>
				parent.handleGuildMemberAddForAccount(state.accountId, member),
			handleReactionAdd: (
				reaction: MessageReaction | PartialMessageReaction,
				user: User | PartialUser,
			) => parent.handleReactionAddForAccount(state.accountId, reaction, user),
			handleReactionRemove: (
				reaction: MessageReaction | PartialMessageReaction,
				user: User | PartialUser,
			) =>
				parent.handleReactionRemoveForAccount(state.accountId, reaction, user),
			refreshOwnerDiscordUserIds: (client: DiscordJsClient) =>
				parent.refreshOwnerDiscordUserIds(client),
			registerSlashCommands: (commands: DiscordSlashCommand[]) =>
				parent.registerSlashCommands(commands, state.accountId),
			clientReadyPromise: state.clientReadyPromise,
			accountToken: state.account.token,
		};
		return facade as unknown as DiscordService;
	}

	private initializeAccount(account: ResolvedDiscordAccount): void {
		const accountId = normalizeAccountId(account.accountId);
		const settings = this.resolveDiscordSettingsForAccount(account);
		const state: DiscordAccountClientState = {
			accountId,
			account: { ...account, accountId },
			client: this.createDiscordJsClient(),
			settings,
			allowedChannelIds: settings.allowedChannelIds,
			listenChannelIds: this.resolveListenChannelIdsForAccount(account),
			dynamicChannelIds: new Set(),
			clientReadyPromise: null,
			loginFailed: false,
		};

		this.accountPool.set(state);
		const facade = this.createAccountServiceFacade(state);
		state.voiceManager = new VoiceManager(
			facade as unknown as DiscordService,
			this.runtime,
		);
		state.messageManager = new MessageManager(facade, this.runtime);

		const client = state.client;
		state.clientReadyPromise = new Promise((resolve, reject) => {
			client.once(Events.ClientReady, async (readyClient) => {
				try {
					await this.onReadyForAccount(state.accountId, readyClient);
					resolve();
				} catch (error) {
					this.runtime.logger.error(
						`Error in Discord onReady for account ${state.accountId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					reject(error);
				}
			});
			client.once(Events.Error, (error) => {
				this.runtime.logger.error(
					`Discord client error for account ${state.accountId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				state.loginFailed = true;
				reject(error);
			});
			client.login(account.token).catch((error) => {
				this.runtime.logger.warn(
					`Failed to login to Discord account ${state.accountId}: ${
						error instanceof Error ? error.message : String(error)
					} — check the configured Discord bot token`,
				);
				state.loginFailed = true;
				state.client?.destroy().catch(() => {});
				state.client = null;
				if (state.accountId === this.defaultAccountId) {
					this.syncLegacyDefaultAliases(state);
				}
				reject(error);
			});
		});

		state.clientReadyPromise.catch((error) => {
			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					accountId: state.accountId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord client ready promise rejected (already logged above)",
			);
			state.loginFailed = true;
			if (state.accountId === this.defaultAccountId) {
				this._loginFailed = true;
			}
		});

		this.setupEventListenersForAccount(state);
	}

	/**
	 * Constructor for Discord client.
	 * Initializes the Discord client with specified intents and partials,
	 * sets up event listeners, and ensures all servers exist.
	 *
	 * @param {IAgentRuntime} runtime - The AgentRuntime instance
	 */
	constructor(runtime: IAgentRuntime) {
		super(runtime);

		// Resolve the account this service instance speaks for. In single-account
		// mode this is DEFAULT_ACCOUNT_ID; in multi-account mode the first
		// configured account wins (the pool will own per-account services).
		this.accountId = (() => {
			try {
				return normalizeAccountId(resolveDefaultDiscordAccountId(runtime));
			} catch {
				return DEFAULT_ACCOUNT_ID;
			}
		})();

		// Load Discord settings with proper priority (env vars > character settings > defaults)
		this.discordSettings = getDiscordSettings(runtime);

		this.character = runtime.character;

		this.defaultAccountId = normalizeAccountId(
			resolveDefaultDiscordAccountId(this.runtime),
		);
		this.accountPool.setDefaultAccountId(this.defaultAccountId);
		this.accountId = this.defaultAccountId;

		const accounts = listEnabledDiscordAccounts(this.runtime);
		if (accounts.length === 0) {
			this.runtime.logger.warn("Discord API Token not provided");
			this.syncLegacyDefaultAliases(null);
			return;
		}

		try {
			for (const account of accounts) {
				this.initializeAccount(account);
			}

			const defaultState = this.getDefaultAccountState();
			if (defaultState) {
				this.defaultAccountId = defaultState.accountId;
				this.accountPool.setDefaultAccountId(defaultState.accountId);
			}
			this.syncLegacyDefaultAliases(defaultState);
			this.runtime.logger.info(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					defaultAccountId: this.defaultAccountId,
					accountIds: this.getAccountIds(),
				},
				"Initialized Discord account client pool",
			);
		} catch (error) {
			runtime.logger.error(
				`Error initializing Discord client: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.syncLegacyDefaultAliases(null);
		}
	}

	public isHealthy(): boolean {
		const state = this.getDefaultAccountState();
		if (this._loginFailed || !state?.client || state.loginFailed) {
			return false;
		}
		return state.client.isReady();
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
		runtime: IAgentRuntime,
		target: TargetInfo,
		content: Content,
	): Promise<void> {
		// Resolve the connector account this outbound message must use.
		// Priority: explicit target.accountId > this service instance's default.
		// `Content.metadata` is intentionally NOT consulted because it may be
		// user-supplied per the MessageMetadata contract — actions thread the
		// trusted inbound `Memory.metadata.accountId` into `target.accountId`.
		const accountId = this.resolveAccountIdFromTarget(target);
		const state = this.getAccountState(accountId);
		const client = state?.client ?? null;
		if (!client?.isReady()) {
			runtime.logger.error("Client not ready");
			throw new Error(`Discord client is not ready for account ${accountId}.`);
		}

		// Reference content to avoid an unused-parameter lint hit; outbound
		// resolution only consults `target.accountId` for trust reasons.
		void content;

		let targetChannel: Channel | undefined | null = null;
		let resolvedChannelId: string | null = null;

		try {
			if (target.channelId) {
				resolvedChannelId = target.channelId;
				targetChannel = await client.channels.fetch(target.channelId);
			} else if (target.roomId) {
				const room =
					typeof runtime.getRoom === "function"
						? await runtime.getRoom(target.roomId as UUID)
						: null;
				const roomChannelId =
					room?.channelId && typeof room.channelId === "string"
						? room.channelId
						: null;
				if (!roomChannelId) {
					throw new Error(
						`Could not resolve Discord channel ID for room ${target.roomId}`,
					);
				}
				resolvedChannelId = roomChannelId;
				targetChannel = await client.channels.fetch(roomChannelId);
			} else if (target.entityId) {
				const discordUserId = await this.resolveDiscordTargetUserId(
					target.entityId as string,
				);
				if (!discordUserId) {
					throw new Error(
						`Could not resolve Discord user ID for runtime entity ${target.entityId}`,
					);
				}
				const user = await client.users.fetch(discordUserId);
				if (user) {
					targetChannel = user.dmChannel ?? (await user.createDM());
				}
			} else {
				throw new Error(
					"Discord SendHandler requires channelId, roomId, or entityId.",
				);
			}

			if (!targetChannel) {
				const targetStr = JSON.stringify(target, (_key, value) => {
					if (typeof value === "bigint") {
						return value.toString();
					}
					return value;
				});
				throw new Error(
					`Could not find target Discord channel/DM for target: ${targetStr}`,
				);
			}

			const allowedByParentThread =
				typeof targetChannel.isThread === "function" &&
				targetChannel.isThread() &&
				"parentId" in targetChannel &&
				typeof targetChannel.parentId === "string" &&
				targetChannel.parentId.length > 0 &&
				this.isChannelAllowed(targetChannel.parentId, accountId);
			if (
				state?.allowedChannelIds &&
				!this.isChannelAllowed(targetChannel.id, accountId) &&
				!allowedByParentThread
			) {
				const resolvedFromText =
					resolvedChannelId && resolvedChannelId !== targetChannel.id
						? ` (resolved from ${resolvedChannelId})`
						: "";
				runtime.logger.warn(
					`Channel ${targetChannel.id}${resolvedFromText} not in allowed list, skipping send`,
				);
				return;
			}

			if (targetChannel.isTextBased() && !targetChannel.isVoiceBased()) {
				if (
					"send" in targetChannel &&
					typeof targetChannel.send === "function"
				) {
					const files: AttachmentBuilder[] = [];
					if (content.attachments && content.attachments.length > 0) {
						for (const media of content.attachments) {
							if (media.url) {
								const fileName = getAttachmentFileName(media);
								files.push(
									new AttachmentBuilder(media.url, { name: fileName }),
								);
							}
						}
					}

					const sentMessages: Message[] = [];
					const roomId = createUniqueUuid(runtime, targetChannel.id);
					const channelType = await this.getChannelType(
						targetChannel as Channel,
					);

					const textContent = normalizeDiscordMessageText(content.text);
					if (textContent || files.length > 0) {
						if (textContent) {
							const chunks = splitMessage(textContent, MAX_MESSAGE_LENGTH);
							if (chunks.length > 1) {
								for (let i = 0; i < chunks.length - 1; i++) {
									const sent = await targetChannel.send(chunks[i]);
									sentMessages.push(sent);
								}
								const sent = await targetChannel.send({
									content: chunks[chunks.length - 1],
									files: files.length > 0 ? files : undefined,
								});
								sentMessages.push(sent);
							} else {
								const sent = await targetChannel.send({
									content: chunks[0],
									files: files.length > 0 ? files : undefined,
								});
								sentMessages.push(sent);
							}
						} else {
							const sent = await targetChannel.send({
								files,
							});
							sentMessages.push(sent);
						}
					} else {
						runtime.logger.warn("No text content or attachments provided");
					}

					const targetChannelGuild =
						"guild" in targetChannel ? targetChannel.guild : null;
					const serverId = targetChannelGuild?.id
						? targetChannelGuild.id
						: targetChannel.id;
					const worldId = createUniqueUuid(runtime, serverId) as UUID;
					const worldName = targetChannelGuild?.name
						? targetChannelGuild.name
						: undefined;

					const clientUser = client.user;
					await this.runtime.ensureConnection({
						entityId: runtime.agentId,
						roomId,
						roomName:
							"name" in targetChannel && typeof targetChannel.name === "string"
								? targetChannel.name
								: clientUser?.displayName || clientUser?.username || undefined,
						userName: clientUser?.username ? clientUser.username : undefined,
						name: clientUser?.displayName || clientUser?.username || undefined,
						source: "discord",
						channelId: targetChannel.id,
						messageServerId: stringToUuid(serverId),
						type: channelType,
						worldId,
						worldName,
						metadata: {
							accountId,
						},
					});

					for (const sentMsg of sentMessages) {
						try {
							const hasAttachments = sentMsg.attachments.size > 0;

							const memory: Memory = {
								id: createUniqueUuid(runtime, sentMsg.id),
								entityId: runtime.agentId,
								agentId: runtime.agentId,
								roomId,
								content: {
									text: sentMsg.content || textContent || " ",
									url: sentMsg.url,
									channelType,
									...(hasAttachments && content.attachments
										? { attachments: content.attachments }
										: {}),
									...(content.action ? { action: content.action } : {}),
								},
								metadata: {
									type: MemoryType.MESSAGE,
									accountId,
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
								"Saved sent message to memory",
							);
						} catch (error) {
							runtime.logger.warn(
								`Failed to save sent message ${sentMsg.id} to memory: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				} else {
					throw new Error(
						`Target channel ${targetChannel.id} does not have a send method.`,
					);
				}
			} else {
				throw new Error(
					`Target channel ${targetChannel.id} is not a valid text-based channel for sending messages.`,
				);
			}
		} catch (error) {
			runtime.logger.error(
				`Error sending message to ${JSON.stringify(target)}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	private buildConnectorChannelTarget(
		channel: Channel,
		score = 0.5,
		accountId = this.defaultAccountId,
	): MessageConnectorTarget | null {
		if (!isDiscordTextTarget(channel)) {
			return null;
		}

		const channelRecord = channel as Channel & {
			guild?: Guild;
			name?: string;
			parentId?: string | null;
			isThread?: () => boolean;
			url?: string;
		};
		const parentId =
			typeof channelRecord.parentId === "string"
				? channelRecord.parentId
				: undefined;
		const isThread = Boolean(channelRecord.isThread?.());
		const state = this.getAccountState(accountId);
		if (
			state?.allowedChannelIds &&
			!this.isChannelAllowed(channel.id, accountId) &&
			!(parentId && this.isChannelAllowed(parentId, accountId))
		) {
			return null;
		}

		const guild = channelRecord.guild;
		const roomId = createUniqueUuid(this.runtime, channel.id) as UUID;
		const label =
			typeof channelRecord.name === "string" && channelRecord.name.length > 0
				? `${isThread ? "Thread" : "#"}${channelRecord.name}`
				: channel.id;

		return {
			target: {
				source: "discord",
				accountId,
				roomId,
				channelId: channel.id,
				serverId: guild?.id,
				threadId: isThread ? channel.id : undefined,
			} as TargetInfo,
			label,
			kind: isThread ? "thread" : "channel",
			description: guild?.name ? `${label} in ${guild.name}` : label,
			score,
			contexts: ["social", "connectors"],
			metadata: {
				accountId,
				discordChannelId: channel.id,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
				discordParentChannelId: parentId,
				channelName: channelRecord.name,
				isThread,
				url: channelRecord.url,
			},
		};
	}

	private buildConnectorUserTarget(
		user: User,
		guild?: Guild | null,
		displayName?: string,
		score = 0.5,
		accountId = this.defaultAccountId,
	): MessageConnectorTarget | null {
		if (!user || user.bot) {
			return null;
		}

		const label = displayName || user.globalName || user.username || user.id;
		return {
			target: {
				source: "discord",
				accountId,
				entityId: user.id as UUID,
				serverId: guild?.id,
			} as TargetInfo,
			label: `@${label}`,
			kind: "user",
			description: guild?.name
				? `Discord user in ${guild.name}`
				: "Discord user",
			score,
			contexts: ["social", "connectors"],
			metadata: {
				accountId,
				discordUserId: user.id,
				discordUsername: user.username,
				discordGlobalName: user.globalName,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
			},
		};
	}

	private dedupeConnectorTargets(
		targets: MessageConnectorTarget[],
	): MessageConnectorTarget[] {
		const byKey = new Map<string, MessageConnectorTarget>();
		for (const target of targets) {
			const key = [
				target.kind ?? "target",
				target.target.channelId ?? "",
				target.target.entityId ?? "",
				target.target.threadId ?? "",
			].join(":");
			const existing = byKey.get(key);
			if (!existing || (target.score ?? 0) > (existing.score ?? 0)) {
				byKey.set(key, target);
			}
		}
		return Array.from(byKey.values()).sort(
			(a, b) => (b.score ?? 0) - (a.score ?? 0),
		);
	}

	public async resolveConnectorTargets(
		query: string,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(
			context.target,
			context,
		);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}

		const normalizedQuery = normalizeDiscordConnectorQuery(query);
		const results: MessageConnectorTarget[] = [];
		const guilds = Array.from(client.guilds.cache.values());

		for (const guild of guilds) {
			const cachedChannels = Array.from(guild.channels.cache.values());
			for (const channel of cachedChannels) {
				if (!channel || !isDiscordTextTarget(channel)) {
					continue;
				}
				const channelRecord = channel as Channel & { name?: string };
				const score = scoreDiscordConnectorMatch(normalizedQuery, channel.id, [
					channelRecord.name,
				]);
				if (score <= 0) {
					continue;
				}
				const target = this.buildConnectorChannelTarget(
					channel,
					score,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			}

			if (normalizedQuery.length >= 2) {
				try {
					const members = await guild.members.fetch({
						query: normalizedQuery,
						limit: 10,
					});
					for (const member of members.values()) {
						const score = scoreDiscordConnectorMatch(
							normalizedQuery,
							member.id,
							[
								member.displayName,
								member.user.username,
								member.user.globalName,
								member.user.tag,
							],
						);
						const target = this.buildConnectorUserTarget(
							member.user,
							guild,
							member.displayName,
							score || 0.65,
							accountId,
						);
						if (target) {
							results.push(target);
						}
					}
				} catch (error) {
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							guildId: guild.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"Discord connector member query failed",
					);
				}
			}

			for (const member of guild.members.cache.values()) {
				const score = scoreDiscordConnectorMatch(normalizedQuery, member.id, [
					member.displayName,
					member.user.username,
					member.user.globalName,
					member.user.tag,
				]);
				if (score <= 0) {
					continue;
				}
				const target = this.buildConnectorUserTarget(
					member.user,
					guild,
					member.displayName,
					score,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			}
		}

		if (DISCORD_SNOWFLAKE_PATTERN.test(normalizedQuery)) {
			try {
				const channel = await client.channels.fetch(normalizedQuery);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						1,
						accountId,
					);
					if (target) {
						results.push(target);
					}
				}
			} catch {
				// Snowflake may be a user id; try user lookup below.
			}
			try {
				const user = await client.users.fetch(normalizedQuery);
				const target = this.buildConnectorUserTarget(
					user,
					null,
					undefined,
					1,
					accountId,
				);
				if (target) {
					results.push(target);
				}
			} catch {
				// No exact user match.
			}
		}

		if (context.target?.channelId) {
			try {
				const channel = await client.channels.fetch(context.target.channelId);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						0.6,
						accountId,
					);
					if (target) {
						results.push(target);
					}
				}
			} catch {
				// Ignore stale current-channel hints.
			}
		}

		return this.dedupeConnectorTargets(results).slice(0, 25);
	}

	public async listConnectorRooms(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(
			context.target,
			context,
		);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}

		const targets: MessageConnectorTarget[] = [];
		for (const guild of client.guilds.cache.values()) {
			for (const channel of guild.channels.cache.values()) {
				const target = this.buildConnectorChannelTarget(
					channel as Channel,
					0.5,
					accountId,
				);
				if (target) {
					targets.push(target);
				}
			}
		}
		return this.dedupeConnectorTargets(targets).slice(0, 50);
	}

	public async listRecentConnectorTargets(
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorTarget[]> {
		const accountId = this.resolveAccountIdFromTarget(
			context.target,
			context,
		);
		const client = this.getClient(accountId);
		const targets: MessageConnectorTarget[] = [];
		const currentRoom =
			context.roomId && typeof context.runtime.getRoom === "function"
				? await context.runtime.getRoom(context.roomId)
				: null;
		const currentChannelId =
			context.target?.channelId ??
			(currentRoom?.source === "discord" ? currentRoom.channelId : undefined);

		if (currentChannelId && client) {
			try {
				const channel = await client.channels.fetch(currentChannelId);
				if (channel) {
					const target = this.buildConnectorChannelTarget(
						channel,
						0.95,
						accountId,
					);
					if (target) {
						targets.push(target);
					}
				}
			} catch {
				// Ignore stale current-channel hints.
			}
		}

		targets.push(...(await this.listConnectorRooms(context)));
		return this.dedupeConnectorTargets(targets).slice(0, 25);
	}

	public async getConnectorChatContext(
		target: TargetInfo,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorChatContext | null> {
		const accountId = this.resolveAccountIdFromTarget(target, context);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}

		const room =
			target.roomId && typeof context.runtime.getRoom === "function"
				? await context.runtime.getRoom(target.roomId)
				: null;
		const channelId = target.channelId ?? room?.channelId;
		if (!channelId) {
			return null;
		}

		const channel = await client.channels.fetch(channelId);
		if (!channel || !isDiscordTextTarget(channel)) {
			return null;
		}

		const channelRecord = channel as Channel & {
			name?: string;
			topic?: string | null;
			guild?: Guild;
			messages?: {
				fetch: (options: {
					limit: number;
				}) => Promise<Collection<string, Message>>;
			};
		};
		const recentMessages: MessageConnectorChatContext["recentMessages"] = [];
		if (channelRecord.messages?.fetch) {
			try {
				const fetched = await channelRecord.messages.fetch({ limit: 10 });
				for (const message of Array.from(fetched.values()).reverse()) {
					if (!message.content?.trim()) {
						continue;
					}
					recentMessages.push({
						entityId: this.resolveDiscordEntityId(message.author.id),
						name:
							message.member?.displayName ||
							message.author.globalName ||
							message.author.username,
						text: message.content,
						timestamp: message.createdTimestamp,
						metadata: {
							accountId,
							discordMessageId: message.id,
							discordUserId: message.author.id,
						},
					});
				}
			} catch (error) {
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Discord connector chat context history fetch failed",
				);
			}
		}

		const label =
			typeof channelRecord.name === "string" && channelRecord.name.length > 0
				? `#${channelRecord.name}`
				: channelId;
		return {
			target: {
				source: "discord",
				accountId,
				roomId: target.roomId ?? room?.id,
				channelId,
				serverId: target.serverId ?? channelRecord.guild?.id,
				threadId: target.threadId,
			} as TargetInfo,
			label,
			summary:
				channelRecord.topic ||
				(channelRecord.guild?.name
					? `Discord channel in ${channelRecord.guild.name}`
					: undefined),
			recentMessages,
			metadata: {
				accountId,
				discordChannelId: channelId,
				discordGuildId: channelRecord.guild?.id,
				discordGuildName: channelRecord.guild?.name,
			},
		};
	}

	public async getConnectorUserContext(
		entityId: UUID | string,
		context: MessageConnectorQueryContext,
	): Promise<MessageConnectorUserContext | null> {
		const accountId = this.resolveAccountIdFromTarget(
			context.target,
			context,
		);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}

		const discordUserId = await this.resolveDiscordTargetUserId(
			String(entityId),
		);
		if (!discordUserId) {
			return null;
		}

		const user = await client.users.fetch(discordUserId);
		if (!user) {
			return null;
		}

		return {
			entityId,
			label: user.globalName || user.username || user.id,
			aliases: [user.username, user.globalName, user.tag].filter(
				(value): value is string => Boolean(value),
			),
			handles: { discord: user.id },
			metadata: {
				accountId,
				discordUserId: user.id,
				discordUsername: user.username,
				discordGlobalName: user.globalName,
				requestRoomId: context.roomId,
			},
		};
	}

	private async resolveConnectorTextChannel(
		target?: TargetInfo | null,
		fallback?: ConnectorFetchMessagesParams | ConnectorChannelMutationParams,
	): Promise<
		Channel & {
			id: string;
			name?: string;
			guild?: Guild;
			messages: TextChannel["messages"];
			permissionsFor?: TextChannel["permissionsFor"];
		}
	> {
		const accountId = this.resolveAccountIdFromTarget(target, fallback);
		const client = this.getClient(accountId);
		if (!client) {
			throw new Error("Discord client is not initialized.");
		}

		let channelId =
			target?.channelId ??
			(fallback && "channelId" in fallback ? fallback.channelId : undefined);
		const roomId =
			target?.roomId ??
			(fallback && "roomId" in fallback ? fallback.roomId : undefined);

		if (roomId && !channelId) {
			const room = await this.runtime.getRoom(roomId);
			channelId = room?.channelId;
		}

		if (!channelId && fallback && "alias" in fallback && fallback.alias) {
			const normalizedAlias = normalizeDiscordConnectorQuery(fallback.alias);
			for (const guild of client.guilds.cache.values()) {
				const found = guild.channels.cache.find((channel) => {
					if (!channel || !isDiscordTextTarget(channel)) {
						return false;
					}
					const channelRecord = channel as Channel & { name?: string };
					return (
						channel.id === normalizedAlias ||
						channelRecord.name?.toLowerCase() === normalizedAlias
					);
				});
				if (found) {
					channelId = found.id;
					break;
				}
			}
		}

		if (!channelId) {
			throw new Error("Discord connector operation requires a channel target.");
		}

		const channel = await client.channels.fetch(channelId);
		if (!channel || !isDiscordTextTarget(channel) || !("messages" in channel)) {
			throw new Error(
				`Discord channel ${channelId} is not a text message channel.`,
			);
		}
		return channel as Channel & {
			id: string;
			name?: string;
			guild?: Guild;
			messages: TextChannel["messages"];
			permissionsFor?: TextChannel["permissionsFor"];
		};
	}

	private async fetchConnectorDiscordMessage(
		params: ConnectorMessageMutationParams,
	): Promise<Message> {
		const messageId = params.messageId;
		if (!messageId) {
			throw new Error("Discord message operation requires messageId.");
		}
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		return (await channel.messages.fetch(messageId)) as Message;
	}

	public async listConnectorServers(
		context: MessageConnectorQueryContext,
	): Promise<World[]> {
		const accountId = this.resolveAccountIdFromTarget(
			context.target,
			context,
		);
		const client = this.getClient(accountId);
		if (!client) {
			return [];
		}
		return Array.from(client.guilds.cache.values()).map((guild) => ({
			id: createUniqueUuid(this.runtime, guild.id),
			agentId: this.runtime.agentId,
			name: guild.name,
			messageServerId: stringToUuid(guild.id),
			metadata: {
				source: "discord",
				accountId,
				discordGuildId: guild.id,
				memberCount: guild.memberCount,
			},
		}));
	}

	public async fetchConnectorMessages(
		_context: MessageConnectorQueryContext,
		params: ConnectorFetchMessagesParams,
	): Promise<Memory[]> {
		const accountId = this.resolveAccountIdFromTarget(
			params.target,
			params,
		);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		const limit = Number.isFinite(params.limit)
			? Math.max(1, Math.min(Number(params.limit), 100))
			: 25;
		const fetchParams: { limit: number; before?: string; after?: string } = {
			limit,
		};
		if (params.before ?? params.cursor) {
			fetchParams.before = params.before ?? params.cursor;
		}
		if (params.after) {
			fetchParams.after = params.after;
		}

		const fetched = await channel.messages.fetch(fetchParams);
		const memories: Memory[] = [];
		for (const discordMessage of fetched.values()) {
			const memory = await this.buildMemoryFromMessage(
				discordMessage as Message,
				{ accountId },
			);
			if (memory) {
				memories.push(memory);
			}
		}
		return memories.sort(
			(left, right) =>
				Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0),
		);
	}

	public async searchConnectorMessages(
		context: MessageConnectorQueryContext,
		params: ConnectorSearchMessagesParams,
	): Promise<Memory[]> {
		const query = params.query?.trim().toLowerCase();
		if (!query) {
			return [];
		}
		const author = params.author?.trim().toLowerCase();
		const memories = await this.fetchConnectorMessages(context, {
			...params,
			limit: Math.max(params.limit ?? 100, 100),
		});
		return memories
			.filter((memory) => {
				const text = String(memory.content?.text ?? "").toLowerCase();
				const name = String(memory.content?.name ?? "").toLowerCase();
				const metadata = memory.metadata as Record<string, unknown> | undefined;
				const sender = metadata?.sender as Record<string, unknown> | undefined;
				const username = String(sender?.username ?? "").toLowerCase();
				const matchesQuery = text.includes(query) || name.includes(query);
				const matchesAuthor =
					!author || name.includes(author) || username.includes(author);
				return matchesQuery && matchesAuthor;
			})
			.slice(0, params.limit ?? 25);
	}

	public async reactConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const accountId = this.resolveAccountIdFromTarget(
			params.target,
			params,
		);
		const state = this.requireAccountState(accountId);
		const emoji = params.emoji?.trim();
		if (!emoji) {
			throw new Error("Discord reaction requires emoji.");
		}
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (params.remove) {
			const clientUserId = state.client?.user?.id;
			const reaction = targetMessage.reactions.cache.find(
				(candidate) =>
					candidate.emoji.name === emoji ||
					candidate.emoji.toString() === emoji,
			);
			if (reaction && clientUserId) {
				await reaction.users.remove(clientUserId);
			}
			return;
		}
		await targetMessage.react(emoji);
	}

	public async editConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<Memory> {
		const accountId = this.resolveAccountIdFromTarget(
			params.target,
			params,
		);
		const state = this.requireAccountState(accountId);
		const text = params.content?.text ?? params.text;
		if (!text?.trim()) {
			throw new Error("Discord edit requires non-empty text.");
		}
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (targetMessage.author.id !== state.client?.user?.id) {
			throw new Error(
				"Discord connector can only edit the bot's own messages.",
			);
		}
		const edited = await targetMessage.edit(text);
		const memory = await this.buildMemoryFromMessage(edited as Message, {
			accountId,
		});
		if (!memory) {
			throw new Error(
				"Discord edit succeeded but could not build updated memory.",
			);
		}
		return memory;
	}

	public async deleteConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		await targetMessage.delete();
	}

	public async pinConnectorMessage(
		_runtime: IAgentRuntime,
		params: ConnectorMessageMutationParams,
	): Promise<void> {
		const targetMessage = await this.fetchConnectorDiscordMessage(params);
		if (params.pin === false) {
			await targetMessage.unpin();
			return;
		}
		await targetMessage.pin();
	}

	public async joinConnectorChannel(
		_runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	): Promise<Room | null> {
		const accountId = this.resolveAccountIdFromTarget(
			params.target,
			params,
		);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		this.addAllowedChannel(channel.id, accountId);

		const guild = "guild" in channel ? channel.guild : null;
		const roomId = createUniqueUuid(this.runtime, channel.id);
		const worldId = createUniqueUuid(this.runtime, guild?.id ?? channel.id);
		const room: Room = {
			id: roomId,
			agentId: this.runtime.agentId,
			name: channel.name ?? channel.id,
			source: "discord",
			type: await this.getChannelType(channel as Channel),
			channelId: channel.id,
			worldId,
			serverId: guild?.id,
			metadata: {
				accountId,
				discordChannelId: channel.id,
				discordGuildId: guild?.id,
				discordGuildName: guild?.name,
			},
		};

		const runtimeWithEnsure = this.runtime as typeof this.runtime & {
			ensureRoomExists?: (room: Room) => Promise<void>;
			createRoom?: (room: Room) => Promise<UUID | void>;
		};
		if (typeof runtimeWithEnsure.ensureRoomExists === "function") {
			await runtimeWithEnsure.ensureRoomExists(room);
		} else if (typeof runtimeWithEnsure.createRoom === "function") {
			const existing = await this.runtime.getRoom(roomId);
			if (!existing) {
				await runtimeWithEnsure.createRoom(room);
			}
		}

		return (await this.runtime.getRoom(roomId)) ?? room;
	}

	public async leaveConnectorChannel(
		_runtime: IAgentRuntime,
		params: ConnectorChannelMutationParams,
	): Promise<void> {
		const accountId = this.resolveAccountIdFromTarget(
			params.target,
			params,
		);
		const channel = await this.resolveConnectorTextChannel(
			params.target,
			params,
		);
		this.removeAllowedChannel(channel.id, accountId);
	}

	public async getConnectorUser(
		_runtime: IAgentRuntime,
		params: ConnectorUserLookupParams,
	): Promise<unknown> {
		const accountId = normalizeAccountId(params.accountId ?? this.defaultAccountId);
		const client = this.getClient(accountId);
		if (!client) {
			return null;
		}
		const lookup =
			params.userId ?? params.handle ?? params.username ?? params.query;
		if (!lookup) {
			return null;
		}

		let user: User | null = null;
		if (DISCORD_SNOWFLAKE_PATTERN.test(lookup)) {
			user = await client.users.fetch(lookup).catch(() => null);
		}
		if (!user) {
			const normalized = normalizeDiscordConnectorQuery(lookup);
			for (const guild of client.guilds.cache.values()) {
				const cached = guild.members.cache.find((member) =>
					[
						member.id,
						member.displayName,
						member.user.username,
						member.user.globalName,
						member.user.tag,
					]
						.filter((value): value is string => Boolean(value))
						.some((value) =>
							normalizeDiscordConnectorQuery(value).includes(normalized),
						),
				);
				if (cached) {
					user = cached.user;
					break;
				}
			}
		}
		if (!user) {
			return null;
		}

		return {
			id: this.resolveDiscordEntityId(user.id),
			agentId: this.runtime.agentId,
			names: [user.globalName, user.username, user.tag].filter(
				(value): value is string => Boolean(value),
			),
			metadata: {
				source: "discord",
				accountId,
				discord: {
					accountId,
					id: user.id,
					userId: user.id,
					username: user.username,
					globalName: user.globalName,
					tag: user.tag,
				},
			},
		};
	}

	/**
	 * Set up event listeners for the client.
	 * Delegates to the extracted setupDiscordEventListeners() function.
	 * @private
	 */
	private setupEventListenersForAccount(state: DiscordAccountClientState) {
		if (!state.client) {
			return;
		}

		const { messageDebouncer, channelDebouncer } = setupDiscordEventListeners(
			this.createAccountServiceFacade(state) as any,
		);

		state.messageDebouncer = messageDebouncer;
		state.channelDebouncer = channelDebouncer;
		if (state.accountId === this.defaultAccountId) {
			this.messageDebouncer = messageDebouncer;
			this.channelDebouncer = channelDebouncer;
		}
	}

	/**
	 * Handles tasks to be performed once the Discord client is fully ready. Delegates to extracted module.
	 * @private
	 */
	private async onReadyForAccount(accountId: string, readyClient: any) {
		const state = this.requireAccountState(accountId);
		return onReadyExtracted(
			this.createAccountServiceFacade(state) as any,
			readyClient,
		);
	}

	private async onReady(readyClient: any) {
		return this.onReadyForAccount(this.defaultAccountId, readyClient);
	}

	/**
	 * Registers send handlers for the Discord service instance.
	 * @static
	 */
	static registerSendHandlers(
		runtime: IAgentRuntime,
		serviceInstance: DiscordService,
	) {
		if (serviceInstance) {
			if (typeof runtime.registerMessageConnector === "function") {
				const accountIds =
					typeof serviceInstance.getAccountIds === "function"
						? serviceInstance.getAccountIds()
						: [];
				const defaultAccountId =
					typeof serviceInstance.getDefaultAccountId === "function"
						? serviceInstance.getDefaultAccountId()
						: DEFAULT_ACCOUNT_ID;
				const registerConnector = (
					accountId: string | undefined,
					legacy = false,
				) => {
					const scopedTarget = (target: TargetInfo): TargetInfo => ({
						...target,
						accountId: accountIdFromRecord(target) ?? accountId,
					} as TargetInfo);
					const scopedContext = (
						context: MessageConnectorQueryContext,
					): MessageConnectorQueryContext => ({
						...context,
						accountId: accountIdFromRecord(context) ?? accountId,
						target: context.target ? scopedTarget(context.target) : undefined,
					} as MessageConnectorQueryContext);
					const scopedFetchParams = <
						T extends
							| ConnectorFetchMessagesParams
							| ConnectorSearchMessagesParams
							| ConnectorMessageMutationParams
							| ConnectorChannelMutationParams
							| ConnectorUserLookupParams,
					>(
						params: T,
					): T => ({
						...params,
						accountId: params.accountId ?? accountId,
						...("target" in params && params.target
							? { target: scopedTarget(params.target) }
							: {}),
					});
					const label = accountId
						? `Discord (${serviceInstance.getAccountLabel(accountId)})`
						: "Discord";
					const registration: ExtendedMessageConnectorRegistration = {
						source: "discord",
						...(accountId ? { accountId } : {}),
						...(accountId
							? {
									account: {
										source: "discord",
										accountId,
										label: serviceInstance.getAccountLabel(accountId),
									},
								}
							: {}),
						label,
						description:
							"Discord connector for sending, reading, searching, reacting to, editing, deleting, pinning, joining, and leaving messages/channels.",
						capabilities: [...DISCORD_CONNECTOR_CAPABILITIES],
						supportedTargetKinds: ["channel", "thread", "user"],
						contexts: [...DISCORD_CONNECTOR_CONTEXTS],
						metadata: {
							service: DISCORD_SERVICE_NAME,
							supportsAttachments: true,
							maxMessageLength: MAX_MESSAGE_LENGTH,
							defaultAccountId,
							...(accountId ? { accountId } : {}),
						},
						resolveTargets: (query, context) =>
							serviceInstance.resolveConnectorTargets(
								query,
								scopedContext(context),
							),
						listRecentTargets: (context) =>
							serviceInstance.listRecentConnectorTargets(
								scopedContext(context),
							),
						listRooms: (context) =>
							serviceInstance.listConnectorRooms(scopedContext(context)),
						listServers: (context) =>
							serviceInstance.listConnectorServers(scopedContext(context)),
						fetchMessages: (context, params) =>
							serviceInstance.fetchConnectorMessages(
								scopedContext(context),
								scopedFetchParams(params),
							),
						searchMessages: (context, params) =>
							serviceInstance.searchConnectorMessages(
								scopedContext(context),
								scopedFetchParams(params),
							),
						reactHandler: (runtime, params) =>
							serviceInstance.reactConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						editHandler: (runtime, params) =>
							serviceInstance.editConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						deleteHandler: (runtime, params) =>
							serviceInstance.deleteConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						pinHandler: (runtime, params) =>
							serviceInstance.pinConnectorMessage(
								runtime,
								scopedFetchParams(params),
							),
						joinHandler: (runtime, params) =>
							serviceInstance.joinConnectorChannel(
								runtime,
								scopedFetchParams(params),
							),
						leaveHandler: (runtime, params) =>
							serviceInstance.leaveConnectorChannel(
								runtime,
								scopedFetchParams(params),
							),
						getUser: (runtime, params) =>
							serviceInstance.getConnectorUser(
								runtime,
								scopedFetchParams(params),
							),
						getChatContext: (target, context) =>
							serviceInstance.getConnectorChatContext(
								scopedTarget(target),
								scopedContext(context),
							),
						getUserContext: (entityId, context) =>
							serviceInstance.getConnectorUserContext(
								entityId,
								scopedContext(context),
							),
						sendHandler: (runtime, target, content) =>
							serviceInstance.handleSendMessage(
								runtime,
								scopedTarget(target),
								content,
							),
					};
					runtime.registerMessageConnector(registration);
					runtime.logger.info(
						accountId && !legacy
							? `Registered Discord message connector for account ${accountId}`
							: "Registered Discord message connector",
					);
				};

				registerConnector(undefined, true);
				for (const accountId of accountIds) {
					registerConnector(accountId);
				}
			} else {
				const sendHandler =
					serviceInstance.handleSendMessage.bind(serviceInstance);
				runtime.registerSendHandler("discord", sendHandler);
				runtime.logger.info("Registered send handler");
			}
		}
	}

	/**
	 * Fetches all members who have access to a specific text channel.
	 */
	public async getTextChannelMembers(
		channelId: string,
		useCache: boolean = true,
		accountId?: string | null,
	): Promise<Array<{ id: string; username: string; displayName: string }>> {
		const state = this.getAccountState(accountId);
		const client = state?.client ?? null;
		this.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				accountId: state?.accountId ?? this.defaultAccountId,
				channelId,
				useCache,
			},
			"Fetching members for text channel",
		);

		try {
			const channel = client
				? ((await client.channels.fetch(channelId)) as TextChannel)
				: null;

			if (!channel) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel not found",
				);
				return [];
			}

			if (channel.type !== DiscordChannelType.GuildText) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel is not a text channel",
				);
				return [];
			}

			const guild = channel.guild;
			if (!guild) {
				this.runtime.logger.error(
					{ src: "plugin:discord", agentId: this.runtime.agentId, channelId },
					"Channel is not in a guild",
				);
				return [];
			}

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
					"Using cached members for large guild",
				);
				members = guild.members.cache;
			} else {
				try {
					if (useCache && guild.members.cache.size > 0) {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								cacheSize: guild.members.cache.size,
							},
							"Using cached members",
						);
						members = guild.members.cache;
					} else {
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								guildId: guild.id,
							},
							"Fetching members for guild",
						);
						members = await guild.members.fetch();
						this.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								memberCount: members.size.toLocaleString(),
							},
							"Fetched members",
						);
					}
				} catch (error) {
					this.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							error: error instanceof Error ? error.message : String(error),
						},
						"Error fetching members",
					);
					members = guild.members.cache;
					this.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: this.runtime.agentId,
							cacheSize: members.size,
						},
						"Fallback to cache",
					);
				}
			}

			this.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					channelId: channel.id,
				},
				"Filtering members for channel access",
			);
			const memberArray: GuildMember[] = Array.from(members.values());
			const channelMembers = memberArray
				.filter((member: GuildMember) => {
					const clientUser = client?.user;
					if (member.user.bot && clientUser && member.id !== clientUser.id) {
						return false;
					}

					return (
						channel
							.permissionsFor(member)
							?.has(PermissionsBitField.Flags.ViewChannel) || false
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
				"Found members with channel access",
			);
			return channelMembers;
		} catch (error) {
			this.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error fetching channel members",
			);
			return [];
		}
	}

	/**
	 * Fetches the topic/description of a Discord text channel.
	 */
	public async getChannelTopic(
		channelId: string,
		accountId?: string | null,
	): Promise<string | null> {
		try {
			const client = this.getClient(accountId);
			const channel = client
				? await client.channels.fetch(channelId)
				: null;
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
				"Failed to fetch channel topic",
			);
			return null;
		}
	}

	/**
	 * Checks if a channel ID is allowed based on both env config and dynamic additions.
	 */
	public isChannelAllowed(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const allowedChannelIds =
			state?.allowedChannelIds ??
			(accountId ? undefined : this.allowedChannelIds);
		const dynamicChannelIds =
			state?.dynamicChannelIds ??
			(accountId ? new Set<string>() : this.dynamicChannelIds);
		if (!allowedChannelIds) {
			return true;
		}
		return (
			allowedChannelIds.includes(channelId) ||
			dynamicChannelIds.has(channelId)
		);
	}

	/**
	 * Adds a channel to the dynamic allowed list.
	 */
	public addAllowedChannel(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const client = state?.client ?? this.client;
		if (!client?.channels.cache.has(channelId)) {
			return false;
		}
		(state?.dynamicChannelIds ?? this.dynamicChannelIds).add(channelId);
		return true;
	}

	/**
	 * Removes a channel from the dynamic allowed list.
	 */
	public removeAllowedChannel(
		channelId: string,
		accountId?: string | null,
	): boolean {
		const state = this.getAccountState(accountId);
		const allowedChannelIds = state?.allowedChannelIds ?? this.allowedChannelIds;
		const dynamicChannelIds = state?.dynamicChannelIds ?? this.dynamicChannelIds;
		if (allowedChannelIds?.includes(channelId)) {
			return false;
		}
		return dynamicChannelIds.delete(channelId);
	}

	/**
	 * Gets the list of all allowed channels (env + dynamic).
	 */
	public getAllowedChannels(accountId?: string | null): string[] {
		const state = this.getAccountState(accountId);
		const envChannels = state?.allowedChannelIds ?? this.allowedChannelIds ?? [];
		const dynamicChannels = Array.from(
			state?.dynamicChannelIds ?? this.dynamicChannelIds,
		);
		return [...new Set([...envChannels, ...dynamicChannels])];
	}

	/**
	 * Fetches and persists message history from a Discord channel. Delegates to extracted module.
	 */
	public async fetchChannelHistory(
		channelId: string,
		options: ChannelHistoryOptions = {},
	): Promise<ChannelHistoryResult> {
		const state = this.getAccountState(options.accountId);
		return fetchChannelHistoryExtracted(
			(state ? this.createAccountServiceFacade(state) : this) as any,
			channelId,
			options,
		);
	}

	/**
	 * Builds a Memory object from a Discord Message. Delegates to extracted module.
	 */
	public async buildMemoryFromMessage(
		message: Message,
		options?: {
			processedContent?: string;
			processedAttachments?: Media[];
			extraContent?: Record<string, unknown>;
			extraMetadata?: Record<string, unknown>;
			accountId?: string;
		},
	): Promise<Memory | null> {
		// Always stamp the connector accountId on inbound memory. Explicit
		// per-call overrides win for legacy callers that already supply one.
		const merged = {
			...options,
			accountId: options?.accountId ?? this.accountId,
		};
		return buildMemoryFromMessageExtracted(this as any, message, merged);
	}

	/**
	 * Resolve which connector account an outbound send should use.
	 *
	 * Priority:
	 *   1. `target.accountId` — explicit override from the action / send call.
	 *      Actions that reply to an inbound message thread the inbound
	 *      `Memory.metadata.accountId` into `target.accountId` here.
	 *   2. This service instance's default account.
	 *
	 * `Content.metadata` is intentionally NOT consulted — per
	 * `MessageMetadata` docs, content metadata may be user-supplied and
	 * cannot be trusted for routing.
	 */
	private resolveOutboundAccountId(
		target: TargetInfo,
		_content: Content,
	): string {
		const fromTarget =
			typeof target.accountId === "string" && target.accountId.trim()
				? normalizeAccountId(target.accountId)
				: undefined;
		if (fromTarget) return fromTarget;

		return this.accountId;
	}

	/**
	 * Maps a Discord snowflake user id to the runtime entity UUID, substituting
	 * the canonical Eliza owner entity when the user is a known Discord owner.
	 */
	public resolveDiscordEntityId(userId: string): UUID {
		return resolveDiscordRuntimeEntityId(
			this.runtime,
			userId,
			this.ownerDiscordUserIds,
		) as UUID;
	}

	/**
	 * Handles reaction addition. Delegates to extracted module.
	 */
	public async handleReactionAdd(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		await this.handleReactionAddForAccount(this.defaultAccountId, reaction, user);
	}

	private async handleReactionAddForAccount(
		accountId: string,
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleReactionAddExtracted(
			this.createAccountServiceFacade(state) as any,
			reaction,
			user,
		);
	}

	/**
	 * Handles reaction removal. Delegates to extracted module.
	 */
	public async handleReactionRemove(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		await this.handleReactionRemoveForAccount(
			this.defaultAccountId,
			reaction,
			user,
		);
	}

	private async handleReactionRemoveForAccount(
		accountId: string,
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleReactionRemoveExtracted(
			this.createAccountServiceFacade(state) as any,
			reaction,
			user,
		);
	}

	/**
	 * Handles guild creation (bot joined a guild). Delegates to extracted module.
	 */
	public async handleGuildCreate(guild: Guild): Promise<void> {
		await handleGuildCreateExtracted(this as any, guild);
	}

	/**
	 * Handles interaction creation (slash commands, modals, etc). Delegates to
	 * extracted module.
	 */
	public async handleInteractionCreate(
		interaction: Interaction,
	): Promise<void> {
		await this.handleInteractionCreateForAccount(
			this.defaultAccountId,
			interaction,
		);
	}

	private async handleInteractionCreateForAccount(
		accountId: string,
		interaction: Interaction,
	): Promise<void> {
		const state = this.requireAccountState(accountId);
		await handleInteractionCreateExtracted(
			this.createAccountServiceFacade(state) as any,
			interaction,
		);
	}

	/**
	 * Handles a new guild member joining — emits an ENTITY_JOINED event so the
	 * runtime can create the entity record.
	 */
	public async handleGuildMemberAdd(member: GuildMember): Promise<void> {
		await this.handleGuildMemberAddForAccount(this.defaultAccountId, member);
	}

	private async handleGuildMemberAddForAccount(
		accountId: string,
		member: GuildMember,
	): Promise<void> {
		this.runtime.logger.info(
			`New member joined: ${member.user.username} (${member.id})`,
		);

		const guild = member.guild;
		const tag = member.user.bot
			? `${member.user.username}#${member.user.discriminator}`
			: member.user.username;

		const worldId = createUniqueUuid(this.runtime, guild.id);
		const entityId = this.resolveDiscordEntityId(member.id);

		this.runtime.emitEvent(
			[DiscordEventTypes.ENTITY_JOINED] as string[],
			{
				runtime: this.runtime,
				entityId,
				worldId,
				source: "discord",
				metadata: {
					accountId,
					type: member.user.bot ? "bot" : "user",
					originalId: member.id,
					username: tag,
					displayName: member.displayName || member.user.username,
					roles: member.roles.cache.map((r) => r.name),
					joinedAt: member.joinedAt?.getTime
						? member.joinedAt.getTime()
						: undefined,
				},
				member,
			} as EventPayload,
		);
	}

	/**
	 * Stops the Discord service and cleans up resources.
	 */
	public async stop(): Promise<void> {
		this.runtime.logger.info("Stopping Discord service");
		this.timeouts.forEach(clearTimeout);
		this.timeouts = [];

		const states = this.accountPool.list();
		for (const state of states) {
			state.messageDebouncer?.destroy();
			state.channelDebouncer?.destroy();
			state.messageDebouncer = undefined;
			state.channelDebouncer = undefined;
		}
		this.messageDebouncer = undefined;
		this.channelDebouncer = undefined;

		this.userSelections.clear();

		for (const state of states) {
			try {
				state.voiceManager?.stop();
			} catch (error) {
				this.runtime.logger.warn(
					`Discord voice cleanup failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		for (const state of states) {
			const client = state.client;
			if (!client) {
				continue;
			}
			try {
				await client.destroy();
				this.runtime.logger.info(
					`Discord client destroyed for account ${state.accountId}`,
				);
			} catch (error) {
				this.runtime.logger.warn(
					`Discord client destroy failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} finally {
				state.client = null;
			}
		}

		this.accountPool.clear();
		this.clientReadyPromise = null;
		this.messageManager = undefined;
		this.voiceManager = undefined;
		this.client = null;
		this.runtime.logger.info("Discord service stopped");
	}

	/**
	 * Asynchronously retrieves the type of a given channel.
	 */
	async getChannelType(channel: Channel): Promise<ChannelType> {
		switch (channel.type) {
			case DiscordChannelType.DM:
				return ChannelType.DM;

			case DiscordChannelType.GroupDM:
				return ChannelType.DM;

			case DiscordChannelType.GuildText:
			case DiscordChannelType.GuildNews:
			case DiscordChannelType.PublicThread:
			case DiscordChannelType.PrivateThread:
			case DiscordChannelType.AnnouncementThread:
			case DiscordChannelType.GuildForum:
				return ChannelType.GROUP;

			case DiscordChannelType.GuildVoice:
			case DiscordChannelType.GuildStageVoice:
				return ChannelType.VOICE_GROUP;

			default:
				this.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						channelType: channel.type,
					},
					"Unknown channel type, defaulting to GROUP",
				);
				return ChannelType.GROUP;
		}
	}
}

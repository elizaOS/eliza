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
	Service,
	setConnectorAdminWhitelist,
	stringToUuid,
	type TargetInfo,
	type UUID,
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
	): Promise<void> {
		await this.clientReadyPromise;

		const clientApplication = this.client?.application;
		if (!clientApplication) {
			this.runtime.logger.warn(
				{ src: "plugin:discord", agentId: this.runtime.agentId },
				"Cannot register commands - Discord client application not available",
			);
			return;
		}

		if (!Array.isArray(commands) || commands.length === 0) {
			this.runtime.logger.warn(
				{ src: "plugin:discord", agentId: this.runtime.agentId },
				"Cannot register commands - no commands provided",
			);
			return;
		}

		for (const cmd of commands) {
			if (!cmd.name || !cmd.description) {
				this.runtime.logger.warn(
					{ src: "plugin:discord", agentId: this.runtime.agentId },
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
					(cmd) => !cmd.guildIds || cmd.guildIds.length === 0,
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

				const clientApp = this.client?.application;
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
							error: err instanceof Error ? err.message : String(err),
						},
						"Failed to register/clear global commands",
					);
				}

				const guilds = this.client?.guilds.cache;
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
		const channelIdsRaw = runtime.getSetting("CHANNEL_IDS") as
			| string
			| undefined;
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
				"Channel restrictions enabled",
			);
		}

		// Check if Discord API token is available and valid
		const token = runtime.getSetting("DISCORD_API_TOKEN") as string;
		const tokenTrimmed =
			token &&
			typeof token === "string" &&
			token.trim &&
			typeof token.trim === "function"
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
				partials: [
					Partials.Channel,
					Partials.Message,
					Partials.User,
					Partials.Reaction,
				],
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
							`Error in onReady: ${error instanceof Error ? error.message : String(error)}`,
						);
						reject(error);
					}
				});
				// Handle client errors that might prevent ready event
				client.once(Events.Error, (error) => {
					this.runtime.logger.error(
						`Discord client error: ${error instanceof Error ? error.message : String(error)}`,
					);
					reject(error);
				});
				// now start login
				client.login(token).catch((error) => {
					this.runtime.logger.error(
						`Failed to login to Discord: ${error instanceof Error ? error.message : String(error)}`,
					);
					if (this.client) {
						this.client.destroy().catch(() => {});
					}
					this.client = null;
					reject(error);
				});
			});

			// Attach error handler to prevent unhandled promise rejection
			this.clientReadyPromise.catch((error) => {
				this.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: this.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Discord client ready promise rejected",
				);
				this._loginFailed = true;
			});

			this.setupEventListeners();
		} catch (error) {
			runtime.logger.error(
				`Error initializing Discord client: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.client = null;
		}
	}

	public isHealthy(): boolean {
		if (this._loginFailed || !this.client) {
			return false;
		}
		return this.client.isReady();
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
		if (!this.client?.isReady()) {
			runtime.logger.error("Client not ready");
			throw new Error("Discord client is not ready.");
		}
		const client = this.client;

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
				this.isChannelAllowed(targetChannel.parentId);
			if (
				this.allowedChannelIds &&
				!this.isChannelAllowed(targetChannel.id) &&
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

	/**
	 * Set up event listeners for the client.
	 * Delegates to the extracted setupDiscordEventListeners() function.
	 * @private
	 */
	private setupEventListeners() {
		if (!this.client) {
			return;
		}

		const { messageDebouncer, channelDebouncer } = setupDiscordEventListeners(
			this as any,
		);

		this.messageDebouncer = messageDebouncer;
		this.channelDebouncer = channelDebouncer;
	}

	/**
	 * Handles tasks to be performed once the Discord client is fully ready. Delegates to extracted module.
	 * @private
	 */
	private async onReady(readyClient: any) {
		return onReadyExtracted(this as any, readyClient);
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
			runtime.registerSendHandler(
				"discord",
				serviceInstance.handleSendMessage.bind(serviceInstance),
			);
			runtime.logger.info("Registered send handler");
		}
	}

	/**
	 * Fetches all members who have access to a specific text channel.
	 */
	public async getTextChannelMembers(
		channelId: string,
		useCache: boolean = true,
	): Promise<Array<{ id: string; username: string; displayName: string }>> {
		this.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: this.runtime.agentId,
				channelId,
				useCache,
			},
			"Fetching members for text channel",
		);

		try {
			const channel = this.client
				? ((await this.client.channels.fetch(channelId)) as TextChannel)
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
					const clientUser = this.client?.user;
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
	public async getChannelTopic(channelId: string): Promise<string | null> {
		try {
			const channel = this.client
				? await this.client.channels.fetch(channelId)
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
	public isChannelAllowed(channelId: string): boolean {
		if (!this.allowedChannelIds) {
			return true;
		}
		return (
			this.allowedChannelIds.includes(channelId) ||
			this.dynamicChannelIds.has(channelId)
		);
	}

	/**
	 * Adds a channel to the dynamic allowed list.
	 */
	public addAllowedChannel(channelId: string): boolean {
		if (!this.client?.channels.cache.has(channelId)) {
			return false;
		}
		this.dynamicChannelIds.add(channelId);
		return true;
	}

	/**
	 * Removes a channel from the dynamic allowed list.
	 */
	public removeAllowedChannel(channelId: string): boolean {
		if (this.allowedChannelIds?.includes(channelId)) {
			return false;
		}
		return this.dynamicChannelIds.delete(channelId);
	}

	/**
	 * Gets the list of all allowed channels (env + dynamic).
	 */
	public getAllowedChannels(): string[] {
		const envChannels = this.allowedChannelIds || [];
		const dynamicChannels = Array.from(this.dynamicChannelIds);
		return [...new Set([...envChannels, ...dynamicChannels])];
	}

	/**
	 * Fetches and persists message history from a Discord channel. Delegates to extracted module.
	 */
	public async fetchChannelHistory(
		channelId: string,
		options: ChannelHistoryOptions = {},
	): Promise<ChannelHistoryResult> {
		return fetchChannelHistoryExtracted(this as any, channelId, options);
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
		},
	): Promise<Memory | null> {
		return buildMemoryFromMessageExtracted(this as any, message, options);
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
		await handleReactionAddExtracted(this as any, reaction, user);
	}

	/**
	 * Handles reaction removal. Delegates to extracted module.
	 */
	public async handleReactionRemove(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
	): Promise<void> {
		await handleReactionRemoveExtracted(this as any, reaction, user);
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
		await handleInteractionCreateExtracted(this as any, interaction);
	}

	/**
	 * Handles a new guild member joining — emits an ENTITY_JOINED event so the
	 * runtime can create the entity record.
	 */
	public async handleGuildMemberAdd(member: GuildMember): Promise<void> {
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

		this.messageDebouncer?.destroy();
		this.channelDebouncer?.destroy();
		this.messageDebouncer = undefined;
		this.channelDebouncer = undefined;

		this.userSelections.clear();

		if (this.voiceManager) {
			try {
				this.voiceManager.stop();
			} catch (error) {
				this.runtime.logger.warn(
					`Discord voice cleanup failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		if (this.client) {
			try {
				await this.client.destroy();
				this.runtime.logger.info("Discord client destroyed");
			} catch (error) {
				this.runtime.logger.warn(
					`Discord client destroy failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} finally {
				this.client = null;
			}
		}

		this.clientReadyPromise = null;
		this.messageManager = undefined;
		this.voiceManager = undefined;
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

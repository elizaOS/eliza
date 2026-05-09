/**
 * Discord event listener setup — extracted from service.ts
 *
 * Contains the body of `setupEventListeners()`: all `client.on(...)` registrations
 * for messageCreate, reactions, guild events, interactions, voice streams,
 * and permission audit events.
 */
import {
	createUniqueUuid,
	type ChannelType as ElizaChannelType,
	type EventPayload,
	type UUID,
} from "@elizaos/core";
import {
	AuditLogEvent,
	type Channel,
	ChannelType as DiscordChannelType,
	type Role as DiscordRole,
	type GuildChannel,
	type GuildMember,
	type Interaction,
	type Message,
	type User,
} from "discord.js";
import {
	type ChannelDebouncer,
	createChannelDebouncer,
	createMessageDebouncer,
	type MessageDebouncer,
} from "./debouncer";
import {
	getDiscordMessageCoalesceConfig,
	makeCoalescedDiscordMessage,
} from "./message-coalesce";
import {
	diffMemberRoles,
	diffOverwrites,
	diffRolePermissions,
	fetchAuditEntry,
} from "./permissionEvents";
import type { DiscordService } from "./service";
import {
	handleAutocomplete as handleBuiltinAutocomplete,
	handleSlashCommand as handleBuiltinSlashCommand,
} from "./slash-commands";
import { recordDiscordChannelMessageSeen } from "./staleness";
import {
	DiscordEventTypes,
	type DiscordListenChannelPayload,
	type DiscordNotInChannelsPayload,
	type DiscordSlashCommand,
} from "./types";

/**
 * Subset of DiscordService fields needed by the event listeners.
 * Because many of the relevant fields are private, the caller passes
 * `this as DiscordServiceInternals`.
 */
export interface DiscordServiceInternals {
	accountId?: string;
	client: NonNullable<DiscordService["client"]>;
	runtime: DiscordService["runtime"];
	character: DiscordService["character"];
	messageManager: DiscordService["messageManager"];
	voiceManager: DiscordService["voiceManager"];
	messageDebouncer: MessageDebouncer | undefined;
	channelDebouncer: ChannelDebouncer | undefined;
	discordSettings: { shouldIgnoreBotMessages: boolean };
	allowedChannelIds: string[] | undefined;
	listenChannelIds?: string[];
	allowAllSlashCommands: Set<string>;
	slashCommands: DiscordSlashCommand[];
	timeouts: ReturnType<typeof setTimeout>[];
	userSelections: Map<string, Record<string, unknown>>;

	// Methods
	isChannelAllowed(channelId: string): boolean;
	resolveDiscordEntityId(userId: string): UUID;
	buildMemoryFromMessage(
		message: Message,
	): Promise<import("@elizaos/core").Memory | null>;
	getChannelType(channel: Channel): Promise<ElizaChannelType>;
	handleInteractionCreate(interaction: Interaction): Promise<void>;
	handleGuildCreate(guild: import("discord.js").Guild): Promise<void>;
	handleGuildMemberAdd(member: GuildMember): Promise<void>;
	handleReactionAdd(
		reaction:
			| import("discord.js").MessageReaction
			| import("discord.js").PartialMessageReaction,
		user: User | import("discord.js").PartialUser,
	): Promise<void>;
	handleReactionRemove(
		reaction:
			| import("discord.js").MessageReaction
			| import("discord.js").PartialMessageReaction,
		user: User | import("discord.js").PartialUser,
	): Promise<void>;
}

/**
 * Parsed debouncer / listen configuration for setupDiscordEventListeners.
 */
interface EventListenerConfig {
	listenCids: string[];
	debounceMs: number;
	channelDebounceMs: number;
	responseCooldownMs: number;
}

function parseEventListenerConfig(
	service: DiscordServiceInternals,
): EventListenerConfig {
	const listenCidsRaw = service.runtime.getSetting(
		"DISCORD_LISTEN_CHANNEL_IDS",
	) as string | string[] | undefined;
	const listenCids = service.listenChannelIds
		? service.listenChannelIds
		: Array.isArray(listenCidsRaw)
			? listenCidsRaw
			: listenCidsRaw &&
					typeof listenCidsRaw === "string" &&
					listenCidsRaw.trim()
				? listenCidsRaw
						.trim()
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: [];

	const debounceMsSetting = service.runtime.getSetting("DISCORD_DEBOUNCE_MS") as
		| string
		| number
		| undefined;
	const debounceMs =
		typeof debounceMsSetting === "number"
			? debounceMsSetting
			: typeof debounceMsSetting === "string" && debounceMsSetting.trim()
				? Number.parseInt(debounceMsSetting, 10) || 400
				: 400;

	const channelDebounceMsSetting = service.runtime.getSetting(
		"DISCORD_CHANNEL_DEBOUNCE_MS",
	) as string | number | undefined;
	const channelDebounceMs =
		typeof channelDebounceMsSetting === "number"
			? channelDebounceMsSetting
			: typeof channelDebounceMsSetting === "string" &&
					channelDebounceMsSetting.trim()
				? Number.parseInt(channelDebounceMsSetting, 10) || 3000
				: 3000;

	const responseCooldownMsSetting = service.runtime.getSetting(
		"DISCORD_RESPONSE_COOLDOWN_MS",
	) as string | number | undefined;
	const responseCooldownMs =
		typeof responseCooldownMsSetting === "number"
			? responseCooldownMsSetting
			: typeof responseCooldownMsSetting === "string" &&
					responseCooldownMsSetting.trim()
				? Number.parseInt(responseCooldownMsSetting, 10) || 30000
				: 30000;

	return { listenCids, debounceMs, channelDebounceMs, responseCooldownMs };
}

/**
 * Wire up all Discord.js event listeners on `service.client`.
 *
 * Returns the created debouncers so the caller can store them on the service
 * instance (they must be destroyed on stop).
 */
export function setupDiscordEventListeners(service: DiscordServiceInternals): {
	messageDebouncer: MessageDebouncer;
	channelDebouncer: ChannelDebouncer;
} {
	const accountId = service.accountId ?? "default";
	const { listenCids, debounceMs, channelDebounceMs, responseCooldownMs } =
		parseEventListenerConfig(service);
	const messageCoalesce = getDiscordMessageCoalesceConfig((key) =>
		service.runtime.getSetting(key),
	);
	const effectiveDebounceMs = messageCoalesce.enabled
		? messageCoalesce.windowMs
		: debounceMs;
	const effectiveChannelDebounceMs = messageCoalesce.enabled
		? messageCoalesce.windowMs
		: channelDebounceMs;

	// ── Message debouncer ──────────────────────────────────────────────
	const messageDebouncer = createMessageDebouncer(
		(messages) => {
			if (!service.messageManager || messages.length === 0) {
				return;
			}

			const anchor = messages[0];
			if (messageCoalesce.enabled) {
				const combined = makeCoalescedDiscordMessage(
					messages,
					anchor,
					messageCoalesce,
				);
				if (messages.length > 1) {
					service.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: messages[0]?.channel?.id,
							messageIds: messages.map((message) => message.id),
							count: messages.length,
							path: "messageDebouncer",
						},
						"Coalesced inbound Discord messages",
					);
				}
				void service.messageManager.handleMessage(combined as Message);
				return;
			}

			if (messages.length === 1) {
				void service.messageManager.handleMessage(anchor);
				return;
			}

			const combinedText = messages
				.map((message) => message.content)
				.join("\n");
			const combined = Object.create(anchor, {
				content: { value: combinedText, writable: true, enumerable: true },
			});
			void service.messageManager.handleMessage(combined as Message);
		},
		effectiveDebounceMs,
		{
			maxBatch: messageCoalesce.enabled ? messageCoalesce.maxBatch : undefined,
		},
	);

	// ── Channel debouncer ──────────────────────────────────────────────
	const channelDebouncer = createChannelDebouncer(
		(messages) => {
			if (!service.messageManager || messages.length === 0) {
				return;
			}

			const clientUser = service.client?.user;
			const botId = clientUser?.id;
			const agentName = service.character?.name?.toLowerCase();

			let anchor: Message | undefined;
			if (botId) {
				anchor = messages.find(
					(message) =>
						message.mentions?.users?.has(botId) ||
						Boolean(
							agentName &&
								agentName.length >= 2 &&
								message.content?.toLowerCase().includes(agentName),
						),
				);
				if (!anchor) {
					anchor = messages.find(
						(message) =>
							Boolean(message.reference?.messageId) &&
							message.mentions?.repliedUser?.id === botId,
					);
				}
			}

			anchor ??= messages[messages.length - 1];
			if (messageCoalesce.enabled) {
				const combined = makeCoalescedDiscordMessage(
					messages,
					anchor,
					messageCoalesce,
				);
				if (messages.length > 1) {
					service.runtime.logger.info(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: messages[0]?.channel?.id,
							messageIds: messages.map((message) => message.id),
							count: messages.length,
							path: "channelDebouncer",
						},
						"Coalesced inbound Discord messages",
					);
				}
				void service.messageManager.handleMessage(combined as Message);
			} else if (messages.length === 1) {
				void service.messageManager.handleMessage(anchor);
			} else {
				const contextLines = messages
					.filter((message) => message.id !== anchor?.id)
					.map(
						(message) =>
							`${message.member?.displayName ?? message.author.globalName ?? message.author.displayName ?? message.author.username}: ${message.content}`,
					);
				const combinedText =
					contextLines.length > 0
						? `[Recent channel context]\n${contextLines.join("\n")}\n\n${anchor.content || ""}`
						: anchor.content || "";
				const combined = Object.create(anchor, {
					content: { value: combinedText, writable: true, enumerable: true },
				});
				void service.messageManager.handleMessage(combined as Message);
			}

			channelDebouncer?.markResponded(messages[0].channel.id);
		},
		{
			debounceMs: effectiveChannelDebounceMs,
			responseCooldownMs,
			getBotUserId: () => service.client?.user?.id,
			botName: service.character?.name,
			coalesceEnabled: messageCoalesce.enabled,
			maxBatch: messageCoalesce.maxBatch,
		},
	);

	service.messageDebouncer = messageDebouncer;
	service.channelDebouncer = channelDebouncer;

	// ── messageCreate ──────────────────────────────────────────────────
	service.client.on("messageCreate", async (message) => {
		const clientUser = service.client?.user;
		if (
			(clientUser && message.author.id === clientUser.id) ||
			(message.author.bot && service.discordSettings.shouldIgnoreBotMessages)
		) {
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					authorId: message.author.id,
					isBot: message.author.bot,
				},
				"Ignoring message from bot or self",
			);
			return;
		}

		if (service.messageManager) {
			recordDiscordChannelMessageSeen(
				service.messageManager,
				message.channel.id,
				message.id,
			);
		}

		if (listenCids.includes(message.channel.id) && message) {
			const newMessage = await service.buildMemoryFromMessage(message);

			if (!newMessage) {
				service.runtime.logger.warn(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						messageId: message.id,
					},
					"Failed to build memory from listen channel message",
				);
				return;
			}

			const listenPayload: DiscordListenChannelPayload = {
				runtime: service.runtime,
				message: newMessage,
				source: "discord",
				accountId,
			};
			service.runtime.emitEvent(
				DiscordEventTypes.LISTEN_CHANNEL_MESSAGE,
				listenPayload,
			);
		}

		// Skip if channel restrictions are set and this channel is not allowed
		if (
			service.allowedChannelIds &&
			!service.isChannelAllowed(message.channel.id)
		) {
			const channel = service.client
				? await service.client.channels.fetch(message.channel.id)
				: null;

			const notInChannelsPayload: DiscordNotInChannelsPayload = {
				runtime: service.runtime,
				message: message,
				source: "discord",
				accountId,
			};
			service.runtime.emitEvent(
				DiscordEventTypes.NOT_IN_CHANNELS_MESSAGE,
				notInChannelsPayload,
			);

			if (!channel) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						channelId: message.channel.id,
					},
					"Channel not found",
				);
				return;
			}
			if (channel.isThread()) {
				if (!channel.parentId || !service.isChannelAllowed(channel.parentId)) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							parentChannelId: channel.parentId,
						},
						"Thread not in allowed channel",
					);
					return;
				}
			} else {
				if (
					channel?.isTextBased &&
					typeof channel.isTextBased === "function" &&
					channel.isTextBased()
				) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: channel.id,
						},
						"Channel not allowed",
					);
				}
				return;
			}
		}

		try {
			if (!service.messageManager) {
				return;
			}

			const channelType = message.channel.type as DiscordChannelType;
			const isDm =
				channelType === DiscordChannelType.DM ||
				channelType === DiscordChannelType.GroupDM;

			if (isDm) {
				if (service.messageDebouncer) {
					service.messageDebouncer.enqueue(message);
				} else {
					await service.messageManager.handleMessage(message);
				}
			} else if (service.channelDebouncer) {
				service.channelDebouncer.enqueue(message);
			} else if (service.messageDebouncer) {
				service.messageDebouncer.enqueue(message);
			} else {
				await service.messageManager.handleMessage(message);
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling message",
			);
		}
	});

	// ── messageReactionAdd ─────────────────────────────────────────────
	service.client.on("messageReactionAdd", async (reaction, user) => {
		const clientUser = service.client?.user;
		if (clientUser && user.id === clientUser.id) {
			return;
		}
		if (
			service.allowedChannelIds &&
			reaction.message.channel &&
			!service.isChannelAllowed(reaction.message.channel.id)
		) {
			return;
		}
		try {
			await service.handleReactionAdd(reaction, user);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling reaction add",
			);
		}
	});

	// ── messageReactionRemove ──────────────────────────────────────────
	service.client.on("messageReactionRemove", async (reaction, user) => {
		const clientUser = service.client?.user;
		if (clientUser && user.id === clientUser.id) {
			return;
		}
		if (
			service.allowedChannelIds &&
			reaction.message.channel &&
			!service.isChannelAllowed(reaction.message.channel.id)
		) {
			return;
		}
		try {
			await service.handleReactionRemove(reaction, user);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling reaction remove",
			);
		}
	});

	// ── guildCreate ────────────────────────────────────────────────────
	service.client.on("guildCreate", async (guild) => {
		try {
			await service.handleGuildCreate(guild);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling guild create",
			);
		}
	});

	// ── guildMemberAdd ─────────────────────────────────────────────────
	service.client.on("guildMemberAdd", async (member) => {
		try {
			await service.handleGuildMemberAdd(member);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling guild member add",
			);
		}
	});

	// ── interactionCreate ──────────────────────────────────────────────
	service.client.on("interactionCreate", async (interaction) => {
		if (interaction.isAutocomplete()) {
			try {
				await handleBuiltinAutocomplete(interaction);
			} catch (error) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error handling Discord autocomplete interaction",
				);
			}
			return;
		}

		const isSlashCommand = interaction.isCommand();
		const isModalSubmit = interaction.isModalSubmit();
		const isComponent = interaction.isMessageComponent();

		const bypassChannelRestriction =
			isSlashCommand &&
			service.allowAllSlashCommands.has(interaction.commandName ?? "");

		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				interactionType: interaction.type,
				commandName: isSlashCommand ? interaction.commandName : undefined,
				channelId: interaction.channelId,
				inGuild: interaction.inGuild(),
				bypassChannelRestriction,
			},
			"[DiscordService] interactionCreate received",
		);

		const isFollowUpInteraction = Boolean(
			interaction.isModalSubmit() ||
				interaction.isMessageComponent() ||
				interaction.isAutocomplete(),
		);

		if (
			!isFollowUpInteraction &&
			service.allowedChannelIds &&
			interaction.channelId &&
			!service.isChannelAllowed(interaction.channelId) &&
			!bypassChannelRestriction
		) {
			if (isSlashCommand && interaction.isCommand()) {
				try {
					await interaction.reply({
						content: "This command is not available in this channel.",
						ephemeral: true,
					});
				} catch (responseError) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							error:
								responseError instanceof Error
									? responseError.message
									: String(responseError),
						},
						"Could not send channel restriction response",
					);
				}
			}
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId: interaction.channelId,
					allowedChannelIds: service.allowedChannelIds,
					isSlashCommand,
					isModalSubmit,
					isComponent,
					bypassChannelRestriction,
				},
				"[DiscordService] interactionCreate ignored (channel not allowed)",
			);
			return;
		}

		// Run custom validator if provided for slash commands
		if (isSlashCommand && interaction.commandName) {
			const command = service.slashCommands.find(
				(cmd) => cmd.name === interaction.commandName,
			);
			if (command?.validator) {
				try {
					const isValid = await command.validator(interaction, service.runtime);
					if (!isValid) {
						if (!interaction.replied) {
							try {
								const errorMessage =
									"You do not have permission to use this command.";
								if (interaction.deferred) {
									await interaction.editReply({ content: errorMessage });
								} else {
									await interaction.reply({
										content: errorMessage,
										ephemeral: true,
									});
								}
							} catch (responseError) {
								service.runtime.logger.debug(
									{
										src: "plugin:discord",
										agentId: service.runtime.agentId,
										commandName: interaction.commandName,
										error:
											responseError instanceof Error
												? responseError.message
												: String(responseError),
									},
									"Could not send validator rejection response (may have already responded)",
								);
							}
						}
						service.runtime.logger.debug(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								commandName: interaction.commandName,
							},
							"[DiscordService] interactionCreate ignored (custom validator returned false)",
						);
						return;
					}
				} catch (error) {
					if (!interaction.replied) {
						try {
							const errorMessage =
								"An error occurred while validating this command.";
							if (interaction.deferred) {
								await interaction.editReply({ content: errorMessage });
							} else {
								await interaction.reply({
									content: errorMessage,
									ephemeral: true,
								});
							}
						} catch (responseError) {
							service.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: service.runtime.agentId,
									commandName: interaction.commandName,
									error:
										responseError instanceof Error
											? responseError.message
											: String(responseError),
								},
								"Could not send validator error response (may have already responded)",
							);
						}
					}
					service.runtime.logger.error(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							commandName: interaction.commandName,
							error: error instanceof Error ? error.message : String(error),
						},
						"[DiscordService] Custom validator threw error",
					);
					return;
				}
			}
		}

		try {
			await service.handleInteractionCreate(interaction);
			if (interaction.isChatInputCommand()) {
				const entityId = service.resolveDiscordEntityId(interaction.user.id);
				const roomId = createUniqueUuid(
					service.runtime,
					interaction.channelId || interaction.user.username,
				);
				await handleBuiltinSlashCommand(interaction, service.runtime, {
					entityId,
					roomId,
				});
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling interaction",
			);
		}
	});

	// ── userStream (voice) ─────────────────────────────────────────────
	service.client.on(
		"userStream",
		(entityId, name, userName, channel, opusDecoder) => {
			const clientUser = service.client?.user;
			if (clientUser && entityId !== clientUser.id) {
				if (service.voiceManager) {
					service.voiceManager.handleUserStream(
						entityId,
						name,
						userName,
						channel,
						opusDecoder,
					);
				}
			}
		},
	);

	// ── Permission Audit Events ────────────────────────────────────────
	const auditLogSetting = service.runtime.getSetting(
		"DISCORD_AUDIT_LOG_ENABLED",
	);
	const isAuditLogEnabled =
		auditLogSetting === "true" ||
		auditLogSetting === true ||
		auditLogSetting === "1" ||
		auditLogSetting === 1;

	if (isAuditLogEnabled) {
		// channelUpdate
		service.client.on("channelUpdate", async (oldChannel, newChannel) => {
			try {
				let channel = newChannel;
				if (channel.partial) {
					channel = await channel.fetch();
				}

				if (!("permissionOverwrites" in oldChannel) || !("guild" in channel)) {
					return;
				}

				const guildChannel = channel as GuildChannel;
				const oldGuildChannel = oldChannel as GuildChannel;
				const oldOverwrites = oldGuildChannel.permissionOverwrites.cache;
				const newOverwrites = guildChannel.permissionOverwrites.cache;

				const allIds = new Set([
					...oldOverwrites.keys(),
					...newOverwrites.keys(),
				]);

				for (const id of allIds) {
					const oldOw = oldOverwrites.get(id);
					const newOw = newOverwrites.get(id);
					const { changes, action } = diffOverwrites(oldOw, newOw);

					if (changes.length === 0) {
						continue;
					}

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
						service.runtime,
					);

					const clientUser = service.client?.user;
					if (
						audit?.executorId &&
						clientUser &&
						audit.executorId === clientUser.id
					) {
						continue;
					}

					const oldOwType =
						oldOw && oldOw.type !== undefined ? oldOw.type : null;
					const newOwType =
						newOw && newOw.type !== undefined ? newOw.type : null;
					const targetType =
						(oldOwType ?? newOwType ?? 1) === 0 ? "role" : "user";
					let targetName: string;
					if (targetType === "role") {
						const role = guildChannel.guild.roles.cache.get(id);
						targetName = role?.name ?? "Unknown";
					} else {
						const user = service.client
							? await service.client.users.fetch(id).catch(() => null)
							: null;
						targetName = user?.tag ?? "Unknown";
					}

					service.runtime.emitEvent(
						DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED,
						{
							runtime: service.runtime,
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
						} as EventPayload,
					);
				}
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in channelUpdate handler",
				);
			}
		});

		// roleUpdate
		service.client.on("roleUpdate", async (oldRole, newRole) => {
			try {
				const changes = diffRolePermissions(oldRole, newRole);
				if (changes.length === 0) {
					return;
				}

				const audit = await fetchAuditEntry(
					newRole.guild,
					AuditLogEvent.RoleUpdate,
					newRole.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_PERMISSIONS_CHANGED, {
					runtime: service.runtime,
					source: "discord",
					guild: { id: newRole.guild.id, name: newRole.guild.name },
					role: { id: newRole.id, name: newRole.name },
					changes,
					audit,
				} as EventPayload);
			} catch (err) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleUpdate handler",
				);
			}
		});

		// guildMemberUpdate
		service.client.on("guildMemberUpdate", async (oldMember, newMember) => {
			try {
				if (!oldMember) {
					return;
				}

				let fullOldMember = oldMember;
				if (oldMember.partial) {
					try {
						fullOldMember = await oldMember.fetch();
					} catch {
						return;
					}
				}

				const { added, removed } = diffMemberRoles(
					fullOldMember as GuildMember,
					newMember,
				);
				if (added.length === 0 && removed.length === 0) {
					return;
				}

				const audit = await fetchAuditEntry(
					newMember.guild,
					AuditLogEvent.MemberRoleUpdate,
					newMember.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.MEMBER_ROLES_CHANGED, {
					runtime: service.runtime,
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
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in guildMemberUpdate handler",
				);
			}
		});

		// roleCreate
		service.client.on("roleCreate", async (role) => {
			try {
				const audit = await fetchAuditEntry(
					role.guild,
					AuditLogEvent.RoleCreate,
					role.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_CREATED, {
					runtime: service.runtime,
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
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleCreate handler",
				);
			}
		});

		// roleDelete
		service.client.on("roleDelete", async (role) => {
			try {
				const audit = await fetchAuditEntry(
					role.guild,
					AuditLogEvent.RoleDelete,
					role.id,
					service.runtime,
				);

				const clientUser = service.client?.user;
				if (
					audit?.executorId &&
					clientUser &&
					audit.executorId === clientUser.id
				) {
					return;
				}

				service.runtime.emitEvent(DiscordEventTypes.ROLE_DELETED, {
					runtime: service.runtime,
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
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error in roleDelete handler",
				);
			}
		});
	} // end if (isAuditLogEnabled)

	return { messageDebouncer, channelDebouncer };
}

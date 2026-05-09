/**
 * Discord interaction handling — extracted from service.ts
 *
 * Contains handleInteractionCreate(), buildStandardizedRooms(),
 * buildStandardizedUsers(), and onReady().
 */
import {
	ChannelType,
	createUniqueUuid,
	type Entity,
	type EventPayload,
	EventType,
	type Room,
	stringToUuid,
	type UUID,
	type World,
} from "@elizaos/core";
import {
	type Channel,
	ChannelType as DiscordChannelType,
	type Guild,
	type GuildMember,
	type Interaction,
	PermissionsBitField,
	type TextChannel,
} from "discord.js";
import type { ICompatRuntime } from "./compat";
import {
	buildDiscordEntityMetadata,
	buildDiscordWorldMetadata,
} from "./identity";
import { generateInviteUrl } from "./permissions";
import { syncDiscordClientProfile } from "./profileSync";
import type { DiscordService } from "./service";
import { registerSlashCommands as registerBuiltinSlashCommands } from "./slash-commands";
import {
	DiscordEventTypes,
	type DiscordRegisterCommandsPayload,
	type DiscordSettings,
	type DiscordSlashCommand,
	type DiscordSlashCommandPayload,
} from "./types";

/**
 * Subset of DiscordService fields needed by interaction handling.
 */
export interface InteractionServiceInternals {
	accountId?: string;
	accountToken?: string;
	client: NonNullable<DiscordService["client"]>;
	runtime: ICompatRuntime;
	character: DiscordService["character"];
	slashCommands: DiscordSlashCommand[];
	userSelections: Map<string, Record<string, unknown>>;
	timeouts: ReturnType<typeof setTimeout>[];
	discordSettings: DiscordSettings;
	clientReadyPromise: Promise<void> | null;

	resolveDiscordEntityId(userId: string): UUID;
	getChannelType(channel: Channel): Promise<ChannelType>;
	registerSlashCommands(commands: DiscordSlashCommand[]): Promise<void>;
	refreshOwnerDiscordUserIds(client: unknown): Promise<void>;
}

/**
 * Handles interactions created by the user (commands, message components).
 */
export async function handleInteractionCreate(
	service: InteractionServiceInternals,
	interaction: Interaction,
): Promise<void> {
	const accountId = service.accountId ?? "default";
	const entityId = service.resolveDiscordEntityId(interaction.user.id);
	const userName = interaction.user.bot
		? `${interaction.user.username}#${interaction.user.discriminator}`
		: interaction.user.username;
	const name = interaction.user.displayName;
	const interactionChannelId = interaction.channel?.id;
	const roomId = createUniqueUuid(
		service.runtime,
		interactionChannelId || userName,
	);

	let type: ChannelType;
	let serverId: string | undefined;

	if (interaction.guild) {
		const guild = await interaction.guild.fetch();
		type = await service.getChannelType(interaction.channel as Channel);
		if (type === null) {
			service.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId: interactionChannelId,
				},
				"Null channel type for interaction",
			);
		}
		serverId = guild.id;
	} else {
		type = ChannelType.DM;
		serverId = interactionChannelId;
	}

	await service.runtime.ensureConnection({
		entityId,
		roomId,
		roomName:
			interaction.guild &&
			interaction.channel &&
			"name" in interaction.channel &&
			typeof interaction.channel.name === "string"
				? interaction.channel.name
				: name,
		userName,
		name,
		source: "discord",
		channelId: interactionChannelId,
		messageServerId: serverId ? stringToUuid(serverId) : undefined,
		type,
		worldId: createUniqueUuid(service.runtime, serverId ?? roomId) as UUID,
		worldName: interaction.guild?.name || undefined,
		userId: interaction.user.id as UUID,
		metadata: {
			...buildDiscordWorldMetadata(service.runtime, interaction.guild?.ownerId),
			accountId,
		},
	});

	if (interaction.isCommand()) {
		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				commandName: interaction.commandName,
				type: interaction.commandType,
				channelId: interaction.channelId,
				inGuild: interaction.inGuild(),
			},
			"[DiscordService] Slash command received",
		);

		try {
			if (!service.client) {
				return;
			}
			const slashPayload: DiscordSlashCommandPayload = {
				runtime: service.runtime,
				source: "discord",
				accountId,
				interaction,
				client: service.client,
				commands: service.slashCommands,
			};
			service.runtime.emitEvent(DiscordEventTypes.SLASH_COMMAND, slashPayload);
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					commandName: interaction.commandName,
				},
				"[DiscordService] Slash command emitted to runtime",
			);
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					commandName: interaction.commandName,
					error: error instanceof Error ? error.message : String(error),
				},
				"[DiscordService] Failed to emit slash command",
			);
			throw error;
		}
	}

	if (interaction.isModalSubmit()) {
		if (!service.client) {
			return;
		}
		const modalPayload: DiscordSlashCommandPayload = {
			runtime: service.runtime,
			source: "discord",
			accountId,
			interaction,
			client: service.client,
			commands: service.slashCommands,
		};
		service.runtime.emitEvent(DiscordEventTypes.MODAL_SUBMIT, modalPayload);
	}

	// Handle message component interactions (buttons, dropdowns, etc.)
	if (interaction.isMessageComponent()) {
		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				customId: interaction.customId,
			},
			"Received component interaction",
		);
		const interactionUser = interaction.user;
		const userId = interactionUser?.id;
		const interactionMessage = interaction.message;
		const messageId = interactionMessage?.id;

		if (!service.userSelections.has(userId)) {
			service.userSelections.set(userId, {});
		}
		const userSelections = service.userSelections.get(userId);
		if (!userSelections) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					entityId: userId,
				},
				"User selections map unexpectedly missing",
			);
			return;
		}

		try {
			if (interaction.isStringSelectMenu()) {
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						entityId: userId,
						customId: interaction.customId,
						values: interaction.values,
					},
					"Values selected",
				);

				const existingSelections =
					(userSelections[messageId] as Record<string, unknown>) || {};
				userSelections[messageId] = {
					...existingSelections,
					[interaction.customId]: interaction.values,
				};

				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						messageId,
						selections: userSelections[messageId],
					},
					"Current selections for message",
				);

				await interaction.deferUpdate();
			}

			if (interaction.isButton()) {
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						entityId: userId,
						customId: interaction.customId,
					},
					"Button pressed",
				);
				const formSelections = userSelections[messageId] || {};

				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						formSelections,
					},
					"Form data being submitted",
				);

				const fallbackTimeout = setTimeout(async () => {
					const index = service.timeouts.indexOf(fallbackTimeout);
					if (index > -1) {
						service.timeouts.splice(index, 1);
					}

					if (!interaction.replied && !interaction.deferred) {
						try {
							await interaction.deferUpdate();
							service.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: service.runtime.agentId,
									customId: interaction.customId,
								},
								"Acknowledged button interaction via fallback",
							);
						} catch (ackError) {
							service.runtime.logger.debug(
								{
									src: "plugin:discord",
									agentId: service.runtime.agentId,
									error:
										ackError instanceof Error
											? ackError.message
											: String(ackError),
								},
								"Fallback acknowledgement skipped",
							);
						}
					}
				}, 2500);
				service.timeouts.push(fallbackTimeout);

				const earlyCheckTimeout = setTimeout(() => {
					if (interaction.replied || interaction.deferred) {
						clearTimeout(fallbackTimeout);
						const index = service.timeouts.indexOf(fallbackTimeout);
						if (index > -1) {
							service.timeouts.splice(index, 1);
						}
					}
					const earlyIndex = service.timeouts.indexOf(earlyCheckTimeout);
					if (earlyIndex > -1) {
						service.timeouts.splice(earlyIndex, 1);
					}
				}, 2000);
				service.timeouts.push(earlyCheckTimeout);

				const interactionPayload: EventPayload & {
					accountId?: string;
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
					runtime: service.runtime,
					source: "discord",
					accountId,
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
				service.runtime.emitEvent(["DISCORD_INTERACTION"], interactionPayload);

				delete userSelections[messageId];
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						messageId,
					},
					"Cleared selections for message",
				);
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error handling component interaction",
			);
			try {
				await interaction.followUp({
					content: "There was an error processing your interaction.",
					ephemeral: true,
				});
			} catch (followUpError) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error:
							followUpError instanceof Error
								? followUpError.message
								: String(followUpError),
					},
					"Error sending follow-up message",
				);
			}
		}
	}
}

/**
 * Builds a standardized list of rooms from Discord guild channels.
 */
export async function buildStandardizedRooms(
	service: InteractionServiceInternals,
	guild: Guild,
	_worldId: UUID,
): Promise<Room[]> {
	const accountId = service.accountId ?? "default";
	const rooms: Room[] = [];

	for (const [channelId, channel] of guild.channels.cache) {
		if (
			channel.type === DiscordChannelType.GuildText ||
			channel.type === DiscordChannelType.GuildVoice
		) {
			const roomId = createUniqueUuid(service.runtime, channelId);
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

			let participants: UUID[] = [];

			if (
				guild.memberCount < 1000 &&
				channel.type === DiscordChannelType.GuildText
			) {
				try {
					participants = Array.from(guild.members.cache.values())
						.filter((member: GuildMember) =>
							channel
								.permissionsFor(member)
								?.has(PermissionsBitField.Flags.ViewChannel),
						)
						.map((member: GuildMember) =>
							service.resolveDiscordEntityId(member.id),
						);
				} catch (error) {
					service.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId: channel.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"Failed to get participants for channel",
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
				 */
				metadata: {
					accountId,
					topic:
						"topic" in channel ? (channel as TextChannel).topic : undefined,
					participants,
				},
			});
		}
	}

	return rooms;
}

/**
 * Builds a standardized list of users (entities) from Discord guild members.
 */
export async function buildStandardizedUsers(
	service: InteractionServiceInternals,
	guild: Guild,
): Promise<Entity[]> {
	const entities: Entity[] = [];
	const clientUser = service.client?.user;
	const botId = clientUser?.id;

	if (guild.memberCount > 1000) {
		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				guildId: guild.id,
				memberCount: guild.memberCount.toLocaleString(),
			},
			"Using optimized user sync for large guild",
		);

		try {
			for (const [, member] of guild.members.cache) {
				const tag = member.user.bot
					? `${member.user.username}#${member.user.discriminator}`
					: member.user.username;

				if (member.id !== botId) {
					entities.push({
						id: service.resolveDiscordEntityId(member.id),
						names: Array.from(
							new Set(
								[
									member.user.username,
									member.displayName,
									member.user.globalName,
								].filter(Boolean) as string[],
							),
						),
						agentId: service.runtime.agentId,
						metadata: buildDiscordEntityMetadata(
							member.id,
							tag,
							member.displayName || member.user.username,
							member.user.globalName ?? undefined,
							member.user.displayAvatarURL(),
						),
					});
				}
			}

			if (entities.length < 100) {
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						guildId: guild.id,
					},
					"Adding online members",
				);
				const onlineMembers = await guild.members.fetch({ limit: 100 });

				for (const [, member] of onlineMembers) {
					if (member.id !== botId) {
						const entityId = service.resolveDiscordEntityId(member.id);
						if (!entities.some((u) => u.id === entityId)) {
							const tag = member.user.bot
								? `${member.user.username}#${member.user.discriminator}`
								: member.user.username;

							entities.push({
								id: entityId,
								names: Array.from(
									new Set(
										[
											member.user.username,
											member.displayName,
											member.user.globalName,
										].filter(Boolean) as string[],
									),
								),
								agentId: service.runtime.agentId,
								metadata: buildDiscordEntityMetadata(
									member.id,
									tag,
									member.displayName || member.user.username,
									member.user.globalName ?? undefined,
									member.user.displayAvatarURL(),
								),
							});
						}
					}
				}
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					guildId: guild.id,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error fetching members",
			);
		}
	} else {
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
						id: service.resolveDiscordEntityId(member.id),
						names: Array.from(
							new Set(
								[
									member.user.username,
									member.displayName,
									member.user.globalName,
								].filter(Boolean) as string[],
							),
						),
						agentId: service.runtime.agentId,
						metadata: buildDiscordEntityMetadata(
							member.id,
							tag,
							member.displayName || member.user.username,
							member.user.globalName ?? undefined,
							member.user.displayAvatarURL(),
						),
					});
				}
			}
		} catch (error) {
			service.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					guildId: guild.id,
					error: error instanceof Error ? error.message : String(error),
				},
				"Error fetching members",
			);
		}
	}

	return entities;
}

/**
 * Handles tasks to be performed once the Discord client is fully ready.
 */
export async function onReady(
	service: InteractionServiceInternals,
	readyClient: any,
): Promise<void> {
	const accountId = service.accountId ?? "default";
	service.runtime.logger.success(
		`Discord client ready for account ${accountId}`,
	);
	const discordApiToken =
		service.accountToken ?? service.runtime.getSetting("DISCORD_API_TOKEN");
	if (
		typeof discordApiToken === "string" &&
		discordApiToken.trim().length > 0 &&
		typeof readyClient.rest?.setToken === "function"
	) {
		readyClient.rest.setToken(discordApiToken.trim());
	}
	await service.refreshOwnerDiscordUserIds(readyClient);

	// Initialize slash commands array
	service.slashCommands = [];

	/**
	 * DISCORD_REGISTER_COMMANDS event handler
	 */
	service.runtime.registerEvent(
		"DISCORD_REGISTER_COMMANDS",
		async (params: DiscordRegisterCommandsPayload) => {
			await service.registerSlashCommands(params.commands);
		},
	);
	await registerBuiltinSlashCommands(service.runtime);

	const auditLogSettingForInvite = service.runtime.getSetting(
		"DISCORD_AUDIT_LOG_ENABLED",
	);
	const isAuditLogEnabledForInvite =
		auditLogSettingForInvite === "true" ||
		auditLogSettingForInvite === true ||
		auditLogSettingForInvite === "1" ||
		auditLogSettingForInvite === 1;

	const readyClientUser = readyClient.user;
	if (readyClientUser) {
		try {
			await syncDiscordClientProfile(
				service.runtime,
				readyClientUser,
				service.discordSettings,
			);
		} catch (error) {
			service.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Failed to synchronize Discord bot profile from connector settings",
			);
		}
	}
	const inviteUrl = readyClientUser?.id
		? generateInviteUrl(readyClientUser.id, "MODERATOR_VOICE")
		: undefined;

	if (isAuditLogEnabledForInvite) {
		service.runtime.logger.info(
			{ src: "plugin:discord", agentId: service.runtime.agentId },
			"Audit log tracking enabled - ensure bot has ViewAuditLog permission in server settings",
		);
	}

	const agentName =
		service.runtime.character.name ||
		readyClientUser?.username ||
		service.runtime.agentId;

	if (inviteUrl) {
		service.runtime.logger.info(
			{ src: "plugin:discord", agentId: service.runtime.agentId, inviteUrl },
			"Bot invite URL generated",
		);
		service.runtime.logger.info(
			`Use this URL to add the "${agentName}" bot to your Discord server: ${inviteUrl}`,
		);
	} else {
		service.runtime.logger.warn(
			{ src: "plugin:discord", agentId: service.runtime.agentId },
			"Could not generate invite URL - bot user ID unavailable",
		);
	}

	service.runtime.logger.success(
		`Discord client logged in successfully as ${readyClientUser?.username || agentName}`,
	);

	const guilds = service.client ? await service.client.guilds.fetch() : null;
	if (!guilds) {
		service.runtime.logger.warn("Could not fetch guilds");
		return;
	}
	for (const [, guild] of guilds) {
		const timeoutId = setTimeout(async () => {
			try {
				const fullGuild = await guild.fetch();
				service.runtime.logger.info(
					`Discord server connected: ${fullGuild.name} (${fullGuild.id})`,
				);

				const worldId = createUniqueUuid(service.runtime, fullGuild.id);
				const standardizedData = {
					name: fullGuild.name,
					runtime: service.runtime,
					rooms: await buildStandardizedRooms(service, fullGuild, worldId),
					entities: await buildStandardizedUsers(service, fullGuild),
					world: {
						id: worldId,
						name: fullGuild.name,
						agentId: service.runtime.agentId,
						serverId: fullGuild.id,
						metadata: {
							...buildDiscordWorldMetadata(service.runtime, fullGuild.ownerId),
							accountId,
						},
					} as World,
					source: "discord",
					accountId,
				};

				service.runtime.emitEvent([DiscordEventTypes.WORLD_CONNECTED], {
					runtime: service.runtime,
					source: "discord",
					accountId,
					world: standardizedData.world,
					rooms: standardizedData.rooms,
					entities: standardizedData.entities,
					server: fullGuild,
				} as EventPayload);

				service.runtime.emitEvent(
					[EventType.WORLD_CONNECTED],
					standardizedData,
				);
			} catch (error) {
				service.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Error during Discord world connection",
				);
			}
		}, 1000);

		service.timeouts.push(timeoutId);
	}

	// Validate audit log access
	const auditLogEnabled = service.runtime.getSetting(
		"DISCORD_AUDIT_LOG_ENABLED",
	);
	if (
		auditLogEnabled === "true" ||
		auditLogEnabled === true ||
		auditLogEnabled === "1" ||
		auditLogEnabled === 1
	) {
		try {
			const testGuild = guilds.first();
			if (testGuild) {
				const fullGuild = await testGuild.fetch();
				await fullGuild.fetchAuditLogs({ limit: 1 });
				service.runtime.logger.debug(
					"Audit log access verified for permission tracking",
				);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const errorCode =
				typeof err === "object" &&
				err !== null &&
				"code" in err &&
				typeof err.code !== "undefined"
					? String(err.code)
					: "";
			const missingAuditLogPermission =
				errorCode === "50013" || errorMessage.includes("Missing Permissions");
			const logMethod = missingAuditLogPermission
				? service.runtime.logger.info
				: service.runtime.logger.warn;
			logMethod.call(
				service.runtime.logger,
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: errorMessage,
				},
				missingAuditLogPermission
					? "Audit log access unavailable - permission change alerts will not include executor info"
					: "Cannot access audit logs - permission change alerts will not include executor info",
			);
		}
	}

	if (service.client) {
		service.client.emit("voiceManagerReady");
	}
}

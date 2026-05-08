/**
 * Discord message history / spidering — extracted from service.ts
 *
 * Contains fetchChannelHistory(), getSpiderState(), saveSpiderState(),
 * buildMemoryFromMessage(), ensureConnectionsForMessages().
 */
import {
	ChannelType,
	type CustomMetadata,
	createUniqueUuid,
	type Media,
	type Memory,
	MemoryType,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type { Channel, GuildTextBasedChannel, Message } from "discord.js";
import type { ICompatRuntime, WorldCompat } from "./compat";
import {
	buildDiscordEntityMetadata,
	buildDiscordWorldMetadata,
} from "./identity";
import type { MessageManager } from "./messages";
import type { DiscordService } from "./service";
import type {
	ChannelHistoryOptions,
	ChannelHistoryResult,
	ChannelSpiderState,
} from "./types";

function formatJsonScalar(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => formatJsonScalar(item)).join(", ");
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, entry]) => `${key}:${formatJsonScalar(entry)}`)
			.join(", ");
	}
	return String(value);
}

function formatSpiderStateJson(state: ChannelSpiderState): string {
	return [
		"state:",
		...Object.entries(state).map(
			([key, value]) => `  ${key}: ${formatJsonScalar(value)}`,
		),
	].join("\n");
}

/**
 * Subset of DiscordService fields needed by history functions.
 */
export interface HistoryServiceInternals {
	client: NonNullable<DiscordService["client"]>;
	runtime: ICompatRuntime;
	messageManager: MessageManager | undefined;

	resolveDiscordEntityId(userId: string): UUID;
	getChannelType(channel: Channel): Promise<ChannelType>;
	isGuildTextBasedChannel(
		channel: Channel | null,
	): channel is GuildTextBasedChannel;
}

/**
 * Helper to delay execution.
 */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get spider state for a channel from the database.
 */
export async function getSpiderState(
	service: HistoryServiceInternals,
	channelId: string,
): Promise<ChannelSpiderState | null> {
	try {
		const stateId = createUniqueUuid(
			service.runtime,
			`discord-spider-state-${channelId}`,
		);

		const stateMemory = await service.runtime.getMemoryById(stateId);

		const stateMemoryContent = stateMemory?.content;
		if (stateMemoryContent?.text) {
			const state = JSON.parse(stateMemory.content.text) as ChannelSpiderState;
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId,
					state,
				},
				"Loaded spider state from database",
			);
			return state;
		}
	} catch (error) {
		service.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				error: error instanceof Error ? error.message : String(error),
				channelId,
			},
			"Failed to load spider state from database",
		);
	}
	return null;
}

/**
 * Save spider state for a channel to the database.
 */
export async function saveSpiderState(
	service: HistoryServiceInternals,
	state: ChannelSpiderState,
): Promise<void> {
	try {
		const stateId = createUniqueUuid(
			service.runtime,
			`discord-spider-state-${state.channelId}`,
		);
		const roomId = createUniqueUuid(service.runtime, state.channelId);

		service.runtime.logger.debug(
			`[SpiderState] Saving channel=${state.channelId} stateId=${stateId}`,
		);

		let existing: Memory | null = null;
		try {
			existing = await service.runtime.getMemoryById(stateId);
			service.runtime.logger.debug(
				`[SpiderState] getMemoryById: ${existing ? "EXISTS" : "NOT_FOUND"}`,
			);
		} catch (lookupError) {
			const lookupErrorMessage =
				lookupError instanceof Error
					? lookupError.message
					: String(lookupError);
			service.runtime.logger.debug(
				`[SpiderState] getMemoryById error: ${lookupErrorMessage}`,
			);
		}

		if (existing) {
			service.runtime.logger.debug(
				"[SpiderState] Deleting existing state before insert",
			);
			try {
				await service.runtime.deleteMemory(stateId);
				service.runtime.logger.debug("[SpiderState] Delete successful");
			} catch (deleteError) {
				const deleteErrorMessage =
					deleteError instanceof Error
						? deleteError.message
						: String(deleteError);
				service.runtime.logger.debug(
					`[SpiderState] Delete error: ${deleteErrorMessage}`,
				);
			}
		}

		let serverId: string | undefined;
		let worldId: UUID;
		let channelName = state.channelId;

		try {
			if (service.client?.isReady?.()) {
				const channel = await service.client.channels.fetch(state.channelId);
				if (channel && "guild" in channel && channel.guild) {
					serverId = channel.guild.id;
					channelName =
						"name" in channel
							? (channel.name ?? state.channelId)
							: state.channelId;
				}
			}
		} catch {
			// If we can't fetch the channel, use a default serverId
		}

		worldId = createUniqueUuid(service.runtime, serverId ?? state.channelId);

		const entityId = service.runtime.agentId;
		try {
			const entity = await service.runtime.getEntityById(entityId);
			if (!entity) {
				await service.runtime.createEntity({
					id: entityId,
					names: ["Spider"],
					agentId: service.runtime.agentId,
					metadata: { source: "discord-spider" },
				});
				service.runtime.logger.debug("[SpiderState] Created entity for agent");
			}
		} catch (entityError) {
			const entityErrorMessage =
				entityError instanceof Error
					? entityError.message
					: String(entityError);
			if (!entityErrorMessage.includes("duplicate key")) {
				service.runtime.logger.debug(
					`[SpiderState] Entity ensure error: ${entityErrorMessage}`,
				);
			}
		}

		try {
			await service.runtime.ensureWorldExists({
				id: worldId,
				name: serverId
					? `Discord Server ${serverId}`
					: `Spider World ${state.channelId}`,
				agentId: service.runtime.agentId,
				messageServerId: stringToUuid(serverId ?? state.channelId),
			});
			service.runtime.logger.debug(`[SpiderState] World ensured: ${worldId}`);
		} catch (worldError) {
			const worldErrorMessage =
				worldError instanceof Error ? worldError.message : String(worldError);
			service.runtime.logger.debug(
				`[SpiderState] World ensure error: ${worldErrorMessage}`,
			);
		}

		try {
			await service.runtime.ensureRoomExists({
				id: roomId,
				name: channelName,
				source: "discord",
				type: ChannelType.GROUP,
				channelId: state.channelId,
				messageServerId: stringToUuid(serverId ?? state.channelId),
				worldId,
			});
			service.runtime.logger.debug(`[SpiderState] Room ensured: ${roomId}`);
		} catch (roomError) {
			const roomErrorMessage =
				roomError instanceof Error ? roomError.message : String(roomError);
			service.runtime.logger.debug(
				`[SpiderState] Room ensure error: ${roomErrorMessage}`,
			);
		}

		try {
			await service.runtime.ensureParticipantInRoom(entityId, roomId);
			service.runtime.logger.debug("[SpiderState] Participant ensured in room");
		} catch (participantError) {
			try {
				await service.runtime.addParticipant(entityId, roomId);
				service.runtime.logger.debug("[SpiderState] Participant added to room");
			} catch {
				const participantErrorMessage = participantError?.message
					? participantError.message
					: String(participantError);
				service.runtime.logger.debug(
					`[SpiderState] Participant ensure error: ${participantErrorMessage}`,
				);
			}
		}

		const stateMemory: Memory = {
			id: stateId,
			agentId: service.runtime.agentId,
			entityId,
			roomId,
			content: {
				text: formatSpiderStateJson(state),
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

		service.runtime.logger.debug("[SpiderState] Inserting new state");
		await service.runtime.createMemory(stateMemory, "custom");

		service.runtime.logger.debug(
			`[SpiderState] Save successful for channel ${state.channelId}`,
		);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const errorCause =
			error &&
			(
				error as {
					cause?: { message?: string; code?: string; detail?: string };
				}
			).cause;
		const causeMsg =
			errorCause?.message || (errorCause ? String(errorCause) : "");
		const causeCode = errorCause?.code || "";
		const causeDetail = errorCause?.detail || "";

		if (
			errorMsg.includes("duplicate key") ||
			errorMsg.includes("unique constraint") ||
			String(causeMsg).includes("duplicate key") ||
			String(causeMsg).includes("unique constraint")
		) {
			service.runtime.logger.debug(
				"[SpiderState] Duplicate key - state already saved by another operation",
			);
		} else {
			service.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					error: errorMsg,
					cause: String(causeMsg),
					causeCode,
					causeDetail,
					channelId: state.channelId,
				},
				"Failed to save spider state to database",
			);
		}
	}
}

/**
 * Builds a Memory object from a Discord Message.
 */
export async function buildMemoryFromMessage(
	service: HistoryServiceInternals,
	message: Message,
	options?: {
		processedContent?: string;
		processedAttachments?: Media[];
		extraContent?: Record<string, unknown>;
		extraMetadata?: Record<string, unknown>;
		/**
		 * Connector account ID this message arrived on. Stamped into
		 * `Memory.metadata.accountId` so downstream actions (and policy
		 * evaluation) can route outbound replies through the same account.
		 */
		accountId?: string;
	},
): Promise<Memory | null> {
	if (!message.author || !message.channel) {
		return null;
	}

	const entityId = service.resolveDiscordEntityId(message.author.id);
	const roomId = createUniqueUuid(service.runtime, message.channel.id);
	const channel = message.channel;
	const channelType = await service.getChannelType(channel as Channel);
	const channelGuild = "guild" in channel ? channel.guild : null;
	const serverId = channelGuild?.id
		? channelGuild.id
		: (message.guild?.id ?? message.channel.id);
	const worldId = serverId
		? createUniqueUuid(service.runtime, serverId)
		: service.runtime.agentId;

	let textContent: string;
	let attachments: Media[];

	const optionsProcessedContent = options?.processedContent;
	const optionsProcessedAttachments = options?.processedAttachments;
	if (
		optionsProcessedContent !== undefined ||
		optionsProcessedAttachments !== undefined
	) {
		textContent = options.processedContent || " ";
		attachments = options.processedAttachments || [];
	} else {
		const processed = service.messageManager
			? await service.messageManager.processMessage(message)
			: { processedContent: message.content, attachments: [] };

		const processedContent = processed?.processedContent;
		textContent =
			processedContent && processedContent.trim().length > 0
				? processedContent
				: message.content || " ";
		attachments = processed?.attachments ?? [];
	}

	const entityName =
		(message.member &&
		"displayName" in message.member &&
		typeof message.member.displayName === "string"
			? message.member.displayName
			: undefined) ??
		("globalName" in message.author &&
		typeof message.author.globalName === "string"
			? message.author.globalName
			: undefined) ??
		message.author.username;
	const discordServerId = (() => {
		const messageChannelGuild =
			"guild" in message.channel ? message.channel.guild : null;
		return messageChannelGuild?.id || message.guild?.id || undefined;
	})();
	const metadata = {
		type: "message" as const,
		source: "discord",
		provider: "discord",
		// Top-level accountId per MessageMetadata contract. Inbound connector
		// stamps this so outbound resolution can route replies back through the
		// same connector account.
		...(options?.accountId ? { accountId: options.accountId } : {}),
		timestamp: message.createdTimestamp ?? Date.now(),
		entityName,
		entityUserName: message.author.username,
		entityAvatarUrl: message.author.displayAvatarURL(),
		fromBot: message.author.bot,
		fromId: message.author.id,
		sourceId: entityId,
		chatType: channelType,
		messageIdFull: message.id,
		sender: {
			id: message.author.id,
			name: entityName,
			username: message.author.username,
		},
		discord: {
			id: message.author.id,
			userId: message.author.id,
			username: message.author.username,
			userName: message.author.username,
			name: entityName,
			messageId: message.id,
			channelId: message.channel.id,
			guildId: discordServerId,
		},
		discordMessageId: message.id,
		discordChannelId: message.channel.id,
		discordServerId,
		tags: [] as string[],
		...(options?.extraMetadata ? options.extraMetadata : {}),
	};

	const memory: Memory = {
		id: createUniqueUuid(service.runtime, message.id),
		entityId,
		agentId: service.runtime.agentId,
		roomId,
		content: {
			text: textContent || " ",
			attachments,
			source: "discord",
			channelType,
			url: message.url,
			inReplyTo: message.reference?.messageId
				? createUniqueUuid(service.runtime, message.reference.messageId)
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
 */
export async function ensureConnectionsForMessages(
	service: HistoryServiceInternals,
	messages: Message[],
	ensuredEntityIds: Set<string> = new Set(),
): Promise<void> {
	if (messages.length === 0) {
		return;
	}

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
		const firstMessage = messages[0];
		const channelType = await service.getChannelType(
			firstMessage.channel as Channel,
		);
		const firstMessageChannelGuild =
			"guild" in firstMessage.channel ? firstMessage.channel.guild : null;
		const serverId = firstMessageChannelGuild?.id
			? firstMessageChannelGuild.id
			: (firstMessage.guild?.id ?? firstMessage.channel.id);
		const worldId = serverId
			? createUniqueUuid(service.runtime, serverId)
			: service.runtime.agentId;

		const entities = Array.from(uniqueAuthors.entries()).map(
			([authorId, message]) => {
				const userName = message.author.username;
				const name =
					(message.member &&
					"displayName" in message.member &&
					typeof message.member.displayName === "string"
						? message.member.displayName
						: undefined) ??
					("globalName" in message.author &&
					typeof message.author.globalName === "string"
						? message.author.globalName
						: undefined) ??
					userName;
				return {
					id: service.resolveDiscordEntityId(authorId),
					names: [userName, name].filter(
						(n): n is string => typeof n === "string" && n.length > 0,
					),
					metadata: buildDiscordEntityMetadata(
						authorId,
						userName,
						name,
						undefined,
						message.author.displayAvatarURL(),
					),
					agentId: service.runtime.agentId,
				};
			},
		);

		const rooms = [
			{
				id: createUniqueUuid(service.runtime, firstMessage.channel.id),
				channelId: firstMessage.channel.id,
				type: channelType,
				source: "discord",
			},
		];

		const world: WorldCompat = {
			id: worldId,
			messageServerId: stringToUuid(serverId),
			name: firstMessage.guild?.name ?? `DM-${firstMessage.channel.id}`,
			agentId: service.runtime.agentId,
			metadata: buildDiscordWorldMetadata(
				service.runtime,
				firstMessageChannelGuild?.ownerId ??
					firstMessage.guild?.ownerId ??
					undefined,
			),
		};

		await service.runtime.ensureConnections(entities, rooms, "discord", world);

		for (const authorId of uniqueAuthors.keys()) {
			ensuredEntityIds.add(authorId);
		}
	} catch (error) {
		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				authorCount: uniqueAuthors.size,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to ensure batch connections for message authors during history fetch",
		);
	}
}

/**
 * Fetches and persists message history from a Discord channel.
 */
export async function fetchChannelHistory(
	service: HistoryServiceInternals,
	channelId: string,
	options: ChannelHistoryOptions = {},
): Promise<ChannelHistoryResult> {
	if (!service.client?.isReady?.()) {
		service.runtime.logger.warn(
			{ src: "plugin:discord", agentId: service.runtime.agentId, channelId },
			"Discord client not ready for history fetch",
		);
		return {
			messages: [],
			stats: { fetched: 0, stored: 0, pages: 0, fullyBackfilled: false },
		};
	}

	const fetchedChannel = await service.client.channels.fetch(channelId);
	if (!service.isGuildTextBasedChannel(fetchedChannel)) {
		service.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				channelId,
				channelType: fetchedChannel?.type ?? null,
			},
			"Channel is not a guild text-based channel",
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
	const worldId = serverId
		? createUniqueUuid(service.runtime, serverId)
		: service.runtime.agentId;

	await service.runtime.ensureWorldExists({
		id: worldId,
		agentId: service.runtime.agentId,
		messageServerId: stringToUuid(serverId),
		name: (() => {
			const channelGuild = "guild" in channel ? channel.guild : null;
			return channelGuild?.name || "Discord";
		})(),
	});

	await service.runtime.ensureRoomExists({
		id: createUniqueUuid(service.runtime, channel.id),
		agentId: service.runtime.agentId,
		name: ("name" in channel && channel.name) || channel.id,
		source: "discord",
		type: await service.getChannelType(channel as Channel),
		channelId: channel.id,
		messageServerId: stringToUuid(serverId),
		worldId,
	});

	// Load spider state
	const spiderState = options.force
		? null
		: await getSpiderState(service, channelId);
	const channelName = ("name" in channel && channel.name) || channelId;

	let consecutiveNoNew = 0;
	let totalStored = 0;
	let totalFetched = 0;
	let pagesProcessed = 0;
	const allMessages: Memory[] = [];
	const startTime = Date.now();
	const ensuredEntityIds = new Set<string>();

	let oldestMessageId: string | undefined =
		spiderState?.oldestMessageId ?? options.before;
	let newestMessageId: string | undefined =
		spiderState?.newestMessageId ?? options.after;
	let oldestMessageTimestamp: number | undefined =
		spiderState?.oldestMessageTimestamp;
	let newestMessageTimestamp: number | undefined =
		spiderState?.newestMessageTimestamp;
	let reachedEnd = false;

	// Phase 1: Catch up on new messages
	if (!options.force && spiderState && spiderState.newestMessageId) {
		const lastDate = spiderState.newestMessageTimestamp
			? new Date(spiderState.newestMessageTimestamp).toISOString().split("T")[0]
			: "unknown";
		service.runtime.logger.info(
			`#${channelName}: Catching up on new messages since ${lastDate}`,
		);

		const catchUpBatches: Message[][] = [];
		let catchUpBefore: string | undefined;
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

			const messages = Array.from(
				batch.values() as IterableIterator<Message>,
			).sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));

			const knownNewestTimestamp = spiderState.newestMessageTimestamp ?? 0;
			const knownNewestId = spiderState.newestMessageId;
			const filteredMessages: Message[] = [];
			for (const msg of messages) {
				const msgTimestamp = msg.createdTimestamp ?? 0;
				if (msgTimestamp > knownNewestTimestamp) {
					filteredMessages.push(msg);
				} else if (
					msgTimestamp === knownNewestTimestamp &&
					msg.id !== knownNewestId
				) {
					filteredMessages.push(msg);
				} else {
					reachedKnownHistory = true;
				}
			}

			if (filteredMessages.length > 0) {
				catchUpBatches.push(filteredMessages);
			}

			if (batch.size < 100 || reachedKnownHistory) {
				break;
			}

			const batchLast = batch.last();
			catchUpBefore = batchLast?.id;
			await delay(250);
		}

		catchUpBatches.reverse();

		let catchUpBatchIndex = 0;
		for (let messages of catchUpBatches) {
			catchUpBatchIndex++;

			if (options.limit) {
				const remaining = options.limit - totalFetched;
				if (remaining <= 0) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId,
							limit: options.limit,
						},
						"Reached fetch limit during catch-up",
					);
					break;
				}
				if (messages.length > remaining) {
					messages = messages.slice(0, remaining);
				}
			}

			totalFetched += messages.length;
			pagesProcessed++;

			if (messages.length > 0) {
				const lastMsg = messages[messages.length - 1];
				const lastTimestamp = lastMsg.createdTimestamp ?? 0;
				if (!newestMessageTimestamp || lastTimestamp > newestMessageTimestamp) {
					newestMessageId = lastMsg.id;
					newestMessageTimestamp = lastTimestamp;
				}
			}

			let catchUpNewCount = 0;
			let catchUpExistingCount = 0;
			const catchUpBatchMemories: Memory[] = [];

			const allMemories: Memory[] = [];
			for (const discordMessage of messages) {
				const memory = await buildMemoryFromMessage(service, discordMessage);
				if (memory?.id) {
					allMemories.push(memory);
				}
			}

			if (allMemories.length > 0) {
				const memoryIds = allMemories
					.map((m) => m.id)
					.filter((id): id is UUID => id !== undefined);
				const existingMemories = await service.runtime.getMemoriesByIds(
					memoryIds,
					"messages",
				);
				const existingIdSet = new Set(existingMemories.map((m) => m.id));

				for (const memory of allMemories) {
					if (memory.id && existingIdSet.has(memory.id)) {
						catchUpExistingCount++;
					} else {
						catchUpNewCount++;
						catchUpBatchMemories.push(memory);
					}
				}
			}

			if (options.onBatch) {
				const shouldContinue = await options.onBatch(catchUpBatchMemories, {
					page: pagesProcessed,
					totalFetched,
					totalStored: totalStored + catchUpBatchMemories.length,
				});

				totalStored += catchUpBatchMemories.length;

				if (shouldContinue === false) {
					service.runtime.logger.debug(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							channelId,
							page: pagesProcessed,
						},
						"Batch handler requested early stop during catch-up",
					);
					break;
				}
			} else {
				await ensureConnectionsForMessages(service, messages, ensuredEntityIds);

				const successfullyPersisted: Memory[] = [];
				for (const memory of catchUpBatchMemories) {
					try {
						await service.runtime.createMemory(memory, "messages");
						successfullyPersisted.push(memory);
					} catch (error) {
						service.runtime.logger.warn(
							{
								src: "plugin:discord",
								agentId: service.runtime.agentId,
								memoryId: memory.id,
								error: error instanceof Error ? error.message : String(error),
							},
							"Failed to persist memory during catch-up",
						);
					}
				}
				allMessages.push(...successfullyPersisted);
				totalStored += successfullyPersisted.length;
			}

			const catchUpHitMiss =
				catchUpExistingCount > 0 && catchUpNewCount === 0
					? "HIT"
					: catchUpNewCount > 0
						? "MISS"
						: "EMPTY";

			await saveSpiderState(service, {
				channelId,
				oldestMessageId,
				newestMessageId,
				oldestMessageTimestamp,
				newestMessageTimestamp,
				lastSpideredAt: Date.now(),
				fullyBackfilled: spiderState.fullyBackfilled,
			});

			const newestDate = newestMessageTimestamp
				? new Date(newestMessageTimestamp).toISOString().split("T")[0]
				: "?";
			const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
			service.runtime.logger.debug(
				`#${channelName}: Catch-up batch ${catchUpBatchIndex}/${catchUpBatches.length} [${catchUpHitMiss}], ${messages.length} msgs fetched (${catchUpNewCount} new, ${catchUpExistingCount} existing), ${totalFetched} total fetched, ${totalStored} total stored, newest date ${newestDate} (${elapsedSec}s)`,
			);
		}

		if (catchUpBatches.length > 0) {
			service.runtime.logger.info(
				`#${channelName}: Caught up ${catchUpBatches.length} batches of new messages`,
			);
		}
	}

	// Phase 2: Determine backfill direction
	let before: string | undefined = options.before;
	let after: string | undefined = options.after;

	if (!options.force && spiderState) {
		if (spiderState.fullyBackfilled) {
			reachedEnd = true;
		} else {
			before = spiderState.oldestMessageId;
			const oldestDate = spiderState.oldestMessageTimestamp
				? new Date(spiderState.oldestMessageTimestamp)
						.toISOString()
						.split("T")[0]
				: "unknown";
			service.runtime.logger.info(
				`#${channelName}: Resuming backfill from ${oldestDate}`,
			);
		}
	} else if (!spiderState) {
		service.runtime.logger.info(
			`#${channelName}: Starting fresh history fetch`,
		);
	}

	// Phase 3: Backfill older messages
	while (!reachedEnd) {
		if (options.limit && totalFetched >= options.limit) {
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId,
					limit: options.limit,
				},
				"Reached fetch limit before backfill batch",
			);
			break;
		}

		pagesProcessed += 1;
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
			(a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0),
		);
		totalFetched += messages.length;

		if (messages.length > 0) {
			const firstMsg = messages[0];
			const lastMsg = messages[messages.length - 1];
			const firstTimestamp = firstMsg.createdTimestamp ?? 0;
			const lastTimestamp = lastMsg.createdTimestamp ?? 0;

			if (!oldestMessageTimestamp || firstTimestamp < oldestMessageTimestamp) {
				oldestMessageId = firstMsg.id;
				oldestMessageTimestamp = firstTimestamp;
			}

			if (!newestMessageTimestamp || lastTimestamp > newestMessageTimestamp) {
				newestMessageId = lastMsg.id;
				newestMessageTimestamp = lastTimestamp;
			}
		}

		const batchMemories: Memory[] = [];
		let newCount = 0;
		let existingCount = 0;

		const allMemories: Memory[] = [];
		for (const discordMessage of messages) {
			const memory = await buildMemoryFromMessage(service, discordMessage);
			if (memory?.id) {
				allMemories.push(memory);
			}
		}

		if (allMemories.length > 0) {
			const memoryIds = allMemories
				.map((m) => m.id)
				.filter((id): id is UUID => id !== undefined);
			const existingMemories = await service.runtime.getMemoriesByIds(
				memoryIds,
				"messages",
			);
			const existingIdSet = new Set(existingMemories.map((m) => m.id));

			for (const memory of allMemories) {
				if (memory.id && existingIdSet.has(memory.id)) {
					existingCount++;
				} else {
					newCount++;
					batchMemories.push(memory);
				}
			}
		}

		const hitMiss =
			existingCount > 0 && newCount === 0
				? "HIT"
				: newCount > 0
					? "MISS"
					: "EMPTY";

		if (options.onBatch) {
			const shouldContinue = await options.onBatch(batchMemories, {
				page: pagesProcessed,
				totalFetched,
				totalStored: totalStored + batchMemories.length,
			});

			totalStored += batchMemories.length;

			if (shouldContinue === false) {
				service.runtime.logger.debug(
					{
						src: "plugin:discord",
						agentId: service.runtime.agentId,
						channelId,
						page: pagesProcessed,
					},
					"Batch handler requested early stop",
				);
				break;
			}
		} else {
			await ensureConnectionsForMessages(service, messages, ensuredEntityIds);

			const successfullyPersisted: Memory[] = [];
			for (const memory of batchMemories) {
				try {
					await service.runtime.createMemory(memory, "messages");
					successfullyPersisted.push(memory);
				} catch (error) {
					service.runtime.logger.warn(
						{
							src: "plugin:discord",
							agentId: service.runtime.agentId,
							memoryId: memory.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"Failed to persist memory during backfill",
					);
				}
			}
			allMessages.push(...successfullyPersisted);
			totalStored += successfullyPersisted.length;
		}
		consecutiveNoNew = batchMemories.length === 0 ? consecutiveNoNew + 1 : 0;

		const incrementalState: ChannelSpiderState = {
			channelId,
			oldestMessageId,
			newestMessageId,
			oldestMessageTimestamp,
			newestMessageTimestamp,
			lastSpideredAt: Date.now(),
			fullyBackfilled: false,
		};
		await saveSpiderState(service, incrementalState);

		const oldestDate = oldestMessageTimestamp
			? new Date(oldestMessageTimestamp).toISOString().split("T")[0]
			: "?";
		const newestDate = newestMessageTimestamp
			? new Date(newestMessageTimestamp).toISOString().split("T")[0]
			: "?";
		const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
		service.runtime.logger.debug(
			`#${channelName}: Page ${pagesProcessed} [${hitMiss}], ${messages.length} msgs fetched (${newCount} new, ${existingCount} existing), ${batchMemories.length} stored, ${totalFetched} total fetched, ${totalStored} total stored, dates ${oldestDate} to ${newestDate} (${elapsedSec}s)`,
		);

		if (pagesProcessed === 1 || pagesProcessed % 10 === 0) {
			service.runtime.logger.info(
				`#${channelName}: Page ${pagesProcessed}, ${totalFetched} msgs fetched, ${totalStored} stored, dates ${oldestDate} to ${newestDate} (${elapsedSec}s)`,
			);
		}

		service.runtime.logger.debug(
			{
				src: "plugin:discord",
				agentId: service.runtime.agentId,
				channelId,
				batchSize: batch.size,
				storedThisBatch: batchMemories.length,
				totalStored,
				totalFetched,
				page: pagesProcessed,
			},
			"Processed channel history batch",
		);

		if (options.limit && totalFetched >= options.limit) {
			service.runtime.logger.debug(
				{
					src: "plugin:discord",
					agentId: service.runtime.agentId,
					channelId,
					limit: options.limit,
				},
				"Reached fetch limit",
			);
			break;
		}

		if (batch.size < 100) {
			reachedEnd = true;
			break;
		}

		if (consecutiveNoNew >= 3) {
			service.runtime.logger.debug(
				{ src: "plugin:discord", agentId: service.runtime.agentId, channelId },
				"Stopping backfill: 3 consecutive pages of existing messages (will resume from oldest on next run)",
			);
			break;
		}

		if (after) {
			const lastMessage = messages[messages.length - 1];
			after = lastMessage?.id;
		} else {
			const firstMessage = messages[0];
			before = firstMessage?.id;
		}

		await delay(250);
	}

	// Update spider state
	const newState: ChannelSpiderState = {
		channelId,
		oldestMessageId,
		newestMessageId,
		oldestMessageTimestamp,
		newestMessageTimestamp,
		lastSpideredAt: Date.now(),
		fullyBackfilled: spiderState?.fullyBackfilled || (reachedEnd && !after),
	};
	await saveSpiderState(service, newState);

	const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
	const dateRange =
		oldestMessageTimestamp && newestMessageTimestamp
			? `${new Date(oldestMessageTimestamp).toISOString().split("T")[0]} to ${new Date(newestMessageTimestamp).toISOString().split("T")[0]}`
			: "no messages";
	const status = newState.fullyBackfilled ? "✓ complete" : "↻ partial";
	service.runtime.logger.info(
		`#${channelName}: ${status} - ${totalFetched} msgs, ${pagesProcessed} pages, ${dateRange} (${elapsedSec}s)`,
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

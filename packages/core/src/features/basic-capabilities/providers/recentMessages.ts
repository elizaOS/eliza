import { getEntityDetails } from "../../../entities.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import { getRelatedEntityIds } from "../../../identity-clusters.ts";
import type {
	CustomMetadata,
	Entity,
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { addHeader, formatMessages, formatPosts } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("RECENT_MESSAGES");
const MAX_RECENT_MESSAGES_LOOKBACK = 50;
const MAX_RECENT_INTERACTIONS = 20;
const INTERNAL_BRIDGE_MESSAGE_SOURCES = new Set(["swarm_synthesis"]);

function isInternalBridgeMessage(memory: Memory): boolean {
	const source =
		typeof memory.content?.source === "string"
			? memory.content.source.trim()
			: "";
	return INTERNAL_BRIDGE_MESSAGE_SOURCES.has(source);
}

function normalizeDialogueText(memory: Memory): string {
	return typeof memory.content?.text === "string"
		? memory.content.text.replace(/\s+/g, " ").trim()
		: "";
}

function dedupeConsecutiveDialogueMessages(messages: Memory[]): Memory[] {
	const deduped: Memory[] = [];
	for (const message of messages) {
		const previous = deduped.at(-1);
		if (
			previous?.entityId === message.entityId &&
			normalizeDialogueText(previous) === normalizeDialogueText(message)
		) {
			continue;
		}
		deduped.push(message);
	}
	return deduped;
}

function buildFormattingFallbackEntity(memory: Memory): Entity | null {
	const metadata = memory.metadata as CustomMetadata | undefined;
	const entityName =
		typeof metadata?.entityName === "string" ? metadata.entityName.trim() : "";

	if (!memory.entityId || entityName.length === 0) {
		return null;
	}

	return {
		id: memory.entityId,
		agentId: memory.agentId,
		names: [entityName],
		metadata: {
			name: entityName,
			userName: entityName,
			username: entityName,
		},
	} as Entity;
}

async function ensureFormattingEntities(
	runtime: IAgentRuntime,
	entities: Entity[],
	messages: Memory[],
): Promise<Entity[]> {
	const entitiesById = new Map<UUID, Entity>();
	for (const entity of entities) {
		if (entity.id) {
			entitiesById.set(entity.id, entity);
		}
	}

	const missingMessageByEntityId = new Map<UUID, Memory>();
	for (const memory of messages) {
		if (!memory.entityId || entitiesById.has(memory.entityId)) {
			continue;
		}

		if (!missingMessageByEntityId.has(memory.entityId)) {
			missingMessageByEntityId.set(memory.entityId, memory);
		}
	}

	const missingEntityIds = Array.from(missingMessageByEntityId.keys());
	if (missingEntityIds.length === 0) {
		return Array.from(entitiesById.values());
	}

	const resolvedEntities = await Promise.all(
		missingEntityIds.map((entityId) => runtime.getEntityById(entityId)),
	);

	for (let i = 0; i < missingEntityIds.length; i += 1) {
		const entityId = missingEntityIds[i];
		const resolvedEntity = resolvedEntities[i];

		if (resolvedEntity) {
			entitiesById.set(entityId, resolvedEntity);
			continue;
		}

		const fallbackMemory = missingMessageByEntityId.get(entityId);
		const fallbackEntity =
			fallbackMemory && buildFormattingFallbackEntity(fallbackMemory);
		if (fallbackEntity) {
			entitiesById.set(entityId, fallbackEntity);
		}
	}

	return Array.from(entitiesById.values());
}

// Move getRecentInteractions outside the provider
/**
 * Retrieves the recent interactions between two entities in a specific context.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} A promise that resolves to an array of Memory objects representing recent interactions.
 */
/**
 * Retrieves the recent interactions between two entities in different rooms excluding a specific room.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} An array of Memory objects representing recent interactions between the two entities.
 */
const getRecentInteractions = async (
	runtime: IAgentRuntime,
	sourceEntityId: UUID,
	targetEntityId: UUID,
	excludeRoomId: UUID,
): Promise<Memory[]> => {
	const sourceEntityIds = await getRelatedEntityIds(runtime, sourceEntityId);
	const roomsByIdentity = await Promise.all(
		sourceEntityIds.map((entityId) =>
			runtime.getRoomsForParticipants([entityId, targetEntityId]),
		),
	);
	const rooms = Array.from(new Set(roomsByIdentity.flat()));
	const otherRooms = rooms.filter((room) => room !== excludeRoomId);
	if (otherRooms.length === 0) {
		return [];
	}

	// Check the existing memories in the database
	return runtime.getMemoriesByRoomIds({
		tableName: "messages",
		roomIds: otherRooms,
		limit: 20,
	});
};

/**
 * A provider object that retrieves recent messages, interactions, and memories based on a given message.
 * @typedef {object} Provider
 * @property {string} name - The name of the provider ("RECENT_MESSAGES").
 * @property {string} description - A description of the provider's purpose ("Recent messages, interactions and other memories").
 * @property {number} position - The position of the provider (100).
 * @property {Function} get - Asynchronous function that retrieves recent messages, interactions, and memories.
 * @param {IAgentRuntime} runtime - The runtime context for the agent.
 * @param {Memory} message - The message to retrieve data from.
 * @returns {object} An object containing data, values, and text sections.
 */
export const recentMessagesProvider: Provider = {
	name: spec.name,
	description: spec.description,
	position: spec.position ?? 100,
	contexts: ["memory", "messaging"],
	contextGate: { anyOf: ["memory", "messaging"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const { roomId } = message;
			const conversationLength = Math.min(
				runtime.getConversationLength(),
				MAX_RECENT_MESSAGES_LOOKBACK,
			);

			// First get room to check for compaction point
			const room = await runtime.getRoom(roomId);

			// Check for compaction point - only load messages after this timestamp
			const lastCompactionAt = room?.metadata?.lastCompactionAt as
				| number
				| undefined;

			// Parallelize initial data fetching operations including recentInteractions
			const [entitiesData, recentMessagesData, recentInteractionsData] =
				await Promise.all([
					getEntityDetails({ runtime, roomId }),
					runtime.getMemories({
						tableName: "messages",
						roomId,
						limit: conversationLength,
						unique: false,
						// Use compaction point to filter history
						start: lastCompactionAt,
					}),
					message.entityId !== runtime.agentId
						? getRecentInteractions(
								runtime,
								message.entityId,
								runtime.agentId,
								roomId,
							).then((interactions) =>
								interactions.slice(0, MAX_RECENT_INTERACTIONS),
							)
						: Promise.resolve([]),
				]);

			// Separate action results from regular messages
			const actionResultMessages = recentMessagesData.filter(
				(msg) => msg.content && msg.content.type === "action_result",
			);

			const dialogueMessages = dedupeConsecutiveDialogueMessages(
				recentMessagesData.filter(
					(msg) =>
						!(msg.content && msg.content.type === "action_result") &&
						!isInternalBridgeMessage(msg),
				),
			);

			// Room entity lookups only include current participants. Historical room
			// context can still contain messages from senders who left the room or
			// whose entity row is temporarily unavailable, so backfill those before
			// formatting to avoid noisy "No entity found for message" warnings.
			const entitiesForFormatting = await ensureFormattingEntities(
				runtime,
				entitiesData,
				[message, ...dialogueMessages],
			);

			// Default to message format if room is not found or type is undefined
			const isPostFormat = room?.type
				? room.type === ChannelType.FEED || room.type === ChannelType.THREAD
				: false;

			// Format recent messages and posts in parallel, using only dialogue messages
			const [formattedRecentMessages, formattedRecentPosts] = await Promise.all(
				[
					formatMessages({
						messages: dialogueMessages,
						entities: entitiesForFormatting,
					}),
					formatPosts({
						messages: dialogueMessages,
						entities: entitiesForFormatting,
						conversationHeader: false,
					}),
				],
			);

			// Action results are formatted exclusively by the ACTION_STATE provider
			// (position 150) to avoid duplication in the LLM context.

			// Create formatted text with headers
			const recentPosts =
				formattedRecentPosts && formattedRecentPosts.length > 0
					? addHeader("# Posts in Thread", formattedRecentPosts)
					: "";

			const recentMessages =
				formattedRecentMessages && formattedRecentMessages.length > 0
					? addHeader("# Conversation Messages", formattedRecentMessages)
					: "";

			// If there are no messages at all, and no current message to process, return a specific message.
			// The check for dialogueMessages.length === 0 ensures we only show this if there's truly nothing.
			if (
				!recentPosts &&
				!recentMessages &&
				dialogueMessages.length === 0 &&
				!message.content.text
			) {
				return {
					data: {
						recentMessages: dialogueMessages,
						recentInteractions: [],
						actionResults: actionResultMessages,
					},
					values: {
						recentPosts: "",
						recentMessages: "",
						recentMessageInteractions: "",
						recentPostInteractions: "",
						recentInteractions: "",
						recentActionResults: "",
					},
					text: "No recent messages available",
				};
			}

			let recentMessage = "No recent message available.";

			if (dialogueMessages.length > 0) {
				// Get the most recent dialogue message (create a copy to avoid mutating original array)
				const mostRecentMessage = [...dialogueMessages].sort(
					(a, b) => (b.createdAt || 0) - (a.createdAt || 0),
				)[0];

				// Format just this single message to get the internal thought
				const formattedSingleMessage = formatMessages({
					messages: [mostRecentMessage],
					entities: entitiesForFormatting,
				});

				if (formattedSingleMessage) {
					recentMessage = formattedSingleMessage;
				}
			}

			const metaData = message.metadata as CustomMetadata;
			const foundEntity = entitiesForFormatting.find(
				(entity: Entity) => entity.id === message.entityId,
			);
			const senderName =
				foundEntity?.names?.[0] || metaData?.entityName || "Unknown User";
			const receivedMessageContent = message.content.text;

			const hasReceivedMessage = !!receivedMessageContent?.trim();

			const receivedMessageHeader = hasReceivedMessage
				? addHeader(
						"# Received Message",
						`${senderName}: ${receivedMessageContent}`,
					)
				: "";

			const focusHeader = hasReceivedMessage
				? addHeader(
						"# Focus your response",
						`You are replying to the above message from **${senderName}**. Keep your answer relevant to that message, but include as context any previous messages in the thread from after your last reply.`,
					)
				: "";

			// Preload all necessary entities for both types of interactions
			const interactionEntityMap = new Map<UUID, Entity>();

			// Only proceed if there are interactions to process
			if (recentInteractionsData.length > 0) {
				// Get unique entity IDs that aren't the runtime agent
				const uniqueEntityIds = [
					...new Set(
						recentInteractionsData
							.map((message) => message.entityId)
							.filter((id) => id !== runtime.agentId),
					),
				];

				// Create a Set for faster lookup
				const uniqueEntityIdSet = new Set(uniqueEntityIds);

				// Add entities already fetched in entitiesData to the map
				const entitiesDataIdSet = new Set<UUID>();
				entitiesForFormatting.forEach((entity: Entity) => {
					const entityId = entity.id;
					if (entityId && uniqueEntityIdSet.has(entityId)) {
						interactionEntityMap.set(entityId, entity);
						entitiesDataIdSet.add(entityId);
					}
				});

				// Get the remaining entities that weren't already loaded
				// Use Set difference for efficient filtering
				const remainingEntityIds = uniqueEntityIds.filter(
					(id) => !entitiesDataIdSet.has(id),
				);

				// Only fetch the entities we don't already have
				if (remainingEntityIds.length > 0) {
					const entities = await Promise.all(
						remainingEntityIds.map((entityId) =>
							runtime.getEntityById(entityId),
						),
					);

					entities.forEach((entity, index) => {
						if (entity) {
							interactionEntityMap.set(remainingEntityIds[index], entity);
						}
					});
				}
			}

			// Format recent message interactions
			const getRecentMessageInteractions = async (
				recentInteractionsData: Memory[],
			): Promise<string> => {
				// Format messages using the pre-fetched entities
				const formattedInteractions = recentInteractionsData.map((message) => {
					const isSelf = message.entityId === runtime.agentId;
					let sender: string;

					if (isSelf) {
						sender = runtime.character.name ?? "Agent";
					} else {
						const interactionEntity = interactionEntityMap.get(
							message.entityId,
						);
						const interactionMetadata = interactionEntity?.metadata;
						sender =
							(interactionMetadata &&
								(interactionMetadata.userName as string)) ||
							"unknown";
					}

					return `${sender}: ${message.content.text}`;
				});

				return formattedInteractions.join("\n");
			};

			// Format recent post interactions
			const getRecentPostInteractions = async (
				recentInteractionsData: Memory[],
				entities: Entity[],
			): Promise<string> => {
				// Combine pre-loaded entities with any other entities
				const combinedEntities = [...entities];

				// Add entities from interactionEntityMap that aren't already in entities
				const actorIds = new Set(entities.map((entity) => entity.id));
				for (const [id, entity] of interactionEntityMap.entries()) {
					if (!actorIds.has(id)) {
						combinedEntities.push(entity);
					}
				}

				const formattedInteractions = formatPosts({
					messages: recentInteractionsData,
					entities: combinedEntities,
					conversationHeader: true,
				});

				return formattedInteractions;
			};

			// Process both types of interactions in parallel
			const [recentMessageInteractions, recentPostInteractions] =
				await Promise.all([
					getRecentMessageInteractions(recentInteractionsData),
					getRecentPostInteractions(
						recentInteractionsData,
						entitiesForFormatting,
					),
				]);

			const data = {
				recentMessages: dialogueMessages,
				recentInteractions: recentInteractionsData,
				actionResults: actionResultMessages,
			};

			const values = {
				recentPosts,
				recentMessages,
				recentMessageInteractions,
				recentPostInteractions,
				recentInteractions: isPostFormat
					? recentPostInteractions
					: recentMessageInteractions,
				recentActionResults: "",
				recentMessage,
			};

			// Combine all text sections
			const text = [
				isPostFormat ? recentPosts : recentMessages,
				// Only add received message and focus headers if there are messages or a current message to process
				recentMessages || recentPosts || message.content.text
					? receivedMessageHeader
					: "",
				recentMessages || recentPosts || message.content.text
					? focusHeader
					: "",
			]
				.filter(Boolean)
				.join("\n\n");

			return {
				data: {
					recentMessages: data.recentMessages,
					recentInteractions: data.recentInteractions,
					actionResults: data.actionResults,
				},
				values,
				text,
			};
		} catch (error) {
			return {
				data: {
					recentMessages: [],
					recentInteractions: [],
					actionResults: [],
					error: error instanceof Error ? error.message : String(error),
				},
				values: {
					recentPosts: "",
					recentMessages: "",
					recentMessageInteractions: "",
					recentPostInteractions: "",
					recentInteractions: "",
					recentActionResults: "",
					recentMessage: "",
				},
				text: "No recent messages available",
			};
		}
	},
};

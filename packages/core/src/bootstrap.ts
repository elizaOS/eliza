import type { UUID } from "node:crypto";
import { v4 } from "uuid";
import { choiceAction } from "./actions/choice.ts";
import { followRoomAction } from "./actions/followRoom.ts";
import { ignoreAction } from "./actions/ignore.ts";
import { muteRoomAction } from "./actions/muteRoom.ts";
import { noneAction } from "./actions/none.ts";
import { replyAction } from "./actions/reply.ts";
import updateRoleAction from "./actions/roles.ts";
import { sendMessageAction } from "./actions/sendMessage.ts";
import updateSettingsAction from "./actions/settings.ts";
import { unfollowRoomAction } from "./actions/unfollowRoom.ts";
import { unmuteRoomAction } from "./actions/unmuteRoom.ts";
import { updateEntityAction } from "./actions/updateEntity.ts";
import { createUniqueUuid } from "./entities.ts";
import { goalEvaluator } from "./evaluators/goal.ts";
import { reflectionEvaluator } from "./evaluators/reflection.ts";
import { providersProvider } from "./providers/providers.ts";
import { logger } from "./logger.ts";
import {
	composePrompt,
	messageHandlerTemplate,
	parseJSONObjectFromText,
	shouldRespondTemplate,
} from "./prompts.ts";
import { actionsProvider } from "./providers/actionExamples.ts";
import { anxietyProvider } from "./providers/anxiety.ts";
import { attachmentsProvider } from "./providers/attachments.ts";
import { capabilitiesProvider } from "./providers/capabilities.ts";
import { characterProvider } from "./providers/character.ts";
import { choiceProvider } from "./providers/choice.ts";
import { entitiesProvider } from "./providers/entities.ts";
import { evaluatorsProvider } from "./providers/evaluators.ts";
import { factsProvider } from "./providers/facts.ts";
import { knowledgeProvider } from "./providers/knowledge.ts";
import { recentMessagesProvider } from "./providers/recentMessages.ts";
import { relationshipsProvider } from "./providers/relationships.ts";
import { roleProvider } from "./providers/roles.ts";
import { settingsProvider } from "./providers/settings.ts";
import { timeProvider } from "./providers/time.ts";
import { TaskService } from "./services/task.ts";
import {
	type ChannelType,
	type Content,
	type Entity,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelTypes,
	type Plugin,
	type Room,
	type World,
} from "./types.ts";
import { ScenarioService } from "./services/scenario.ts";

type ServerJoinedParams = {
	runtime: IAgentRuntime;
	world: any; // Platform-specific server object
	source: string; // "discord", "telegram", etc.
};

// Add this to your types.ts file
type ServerConnectedParams = {
	runtime: IAgentRuntime;
	world: World;
	rooms: Room[];
	users: Entity[];
	source: string;
};

type UserJoinedParams = {
	runtime: IAgentRuntime;
	user: any;
	serverId: string;
	entityId: UUID;
	channelId: string;
	channelType: ChannelType;
	source: string;
};

type MessageReceivedHandlerParams = {
	runtime: IAgentRuntime;
	message: Memory;
	callback: HandlerCallback;
};

const latestResponseIds = new Map<string, Map<string, string>>();

const messageReceivedHandler = async ({
	runtime,
	message,
	callback,
}: MessageReceivedHandlerParams) => {
	// Generate a new response ID
	const responseId = v4();
	// Get or create the agent-specific map
	if (!latestResponseIds.has(runtime.agentId)) {
		latestResponseIds.set(runtime.agentId, new Map());
	}
	const agentResponses = latestResponseIds.get(runtime.agentId)!;

	// Set this as the latest response ID for this agent+room
	agentResponses.set(message.roomId, responseId);

	if (message.entityId === runtime.agentId) {
		throw new Error("Message is from the agent itself");
	}

	// First, save the incoming message
	await Promise.all([
		runtime.getMemoryManager("messages").addEmbeddingToMemory(message),
		runtime.getMemoryManager("messages").createMemory(message),
	]);

	const agentUserState = await runtime
		.getDatabaseAdapter()
		.getParticipantUserState(message.roomId, runtime.agentId);

	if (
		agentUserState === "MUTED" &&
		!message.content.text
			.toLowerCase()
			.includes(runtime.character.name.toLowerCase())
	) {
		console.log("Ignoring muted room");
		return;
	}

	let state = await runtime.composeState(message, [
		"PROVIDERS",
		"SHOULD_RESPOND",
		"CHARACTER",
		"RECENT_MESSAGES",
		"ENTITIES",
	]);

	const shouldRespondPrompt = composePrompt({
		state,
		template:
			runtime.character.templates?.shouldRespondTemplate ||
			shouldRespondTemplate,
	});

	const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
		prompt: shouldRespondPrompt,
	});

	const responseObject = parseJSONObjectFromText(response);

	const providers = responseObject.providers;

	const shouldRespond =
		responseObject?.action && responseObject.action === "RESPOND";

	state = await runtime.composeState(message, null, providers);

	let responseMessages: Memory[] = [];

	if (shouldRespond) {
		const prompt = composePrompt({
			state,
			template:
				runtime.character.templates?.messageHandlerTemplate ||
				messageHandlerTemplate,
		});

		let responseContent = null;

		// Retry if missing required fields
		let retries = 0;
		const maxRetries = 3;
		while (
			retries < maxRetries &&
			(!responseContent?.thought ||
				!responseContent?.plan ||
				!responseContent?.actions)
		) {
			const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
				prompt,
			});

			responseContent = parseJSONObjectFromText(response) as Content;

			retries++;
			if (
				!responseContent?.thought ||
				!responseContent?.plan ||
				!responseContent?.actions
			) {
				logger.warn("*** Missing required fields, retrying... ***");
			}
		}

		// Check if this is still the latest response ID for this agent+room
		const currentResponseId = agentResponses.get(message.roomId);
		if (currentResponseId !== responseId) {
			logger.info(
				`Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`,
			);
			return;
		}

		responseContent.plan = responseContent.plan?.trim();
		responseContent.inReplyTo = createUniqueUuid(runtime, message.id);

		responseMessages = [
			{
				id: v4() as UUID,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		// save the plan to a new reply memory
		await runtime.getMemoryManager("messages").createMemory({
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			content: {
				thought: responseContent.thought,
				plan: responseContent.plan,
				actions: responseContent.actions,
				providers: responseContent.providers,
			},
			roomId: message.roomId,
			createdAt: Date.now(),
		});

		// Clean up the response ID
		agentResponses.delete(message.roomId);
		if (agentResponses.size === 0) {
			latestResponseIds.delete(runtime.agentId);
		}

		await runtime.processActions(message, responseMessages, state, callback);
	}

	await runtime.evaluate(
		message,
		state,
		shouldRespond,
		callback,
		responseMessages,
	);
};

const reactionReceivedHandler = async ({
	runtime,
	message,
}: {
	runtime: IAgentRuntime;
	message: Memory;
}) => {
	try {
		await runtime.getMemoryManager("messages").createMemory(message);
	} catch (error) {
		if (error.code === "23505") {
			logger.warn("Duplicate reaction memory, skipping");
			return;
		}
		logger.error("Error in reaction handler:", error);
	}
};

/**
 * Syncs a single user into an entity
 */
const syncSingleUser = async (
	entityId: UUID,
	runtime: IAgentRuntime,
	user: any,
	serverId: string,
	channelId: string,
	type: ChannelType,
	source: string,
) => {
	logger.info(`Syncing user: ${user.username || user.id}`);

	try {
		// Ensure we're not using WORLD type and that we have a valid channelId
		if (!channelId) {
			logger.warn(`Cannot sync user ${user.id} without a valid channelId`);
			return;
		}

		const roomId = createUniqueUuid(runtime, channelId);
		const worldId = createUniqueUuid(runtime, serverId);

		await runtime.ensureConnection({
			entityId,
			roomId,
			userName: user.username || user.displayName || `User${user.id}`,
			name: user.displayName || user.username || `User${user.id}`,
			source,
			channelId,
			serverId,
			type,
			worldId,
		});

		logger.success(`Successfully synced user: ${user.username || user.id}`);
	} catch (error) {
		logger.error(
			`Error syncing user: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

/**
 * Handles standardized server data for both SERVER_JOINED and SERVER_CONNECTED events
 */
const handleServerSync = async ({
	runtime,
	world,
	rooms,
	users,
	source,
}: ServerConnectedParams) => {
	logger.info(`Handling server sync event for server: ${world.name}`);
	try {
		// Create/ensure the world exists for this server
		await runtime.ensureWorldExists({
			id: world.id,
			name: world.name,
			agentId: runtime.agentId,
			serverId: world.serverId,
			metadata: {
				...world.metadata,
			},
		});

		// First sync all rooms/channels
		if (rooms && rooms.length > 0) {
			for (const room of rooms) {
				await runtime.ensureRoomExists({
					id: room.id,
					name: room.name,
					source: source,
					type: room.type,
					channelId: room.channelId,
					serverId: world.serverId,
					worldId: world.id,
				});
			}
		}

		// Then sync all users
		if (users && users.length > 0) {
			// Process users in batches to avoid overwhelming the system
			const batchSize = 50;
			for (let i = 0; i < users.length; i += batchSize) {
				const entityBatch = users.slice(i, i + batchSize);

				// check if user is in any of these rooms in rooms
				const firstRoomUserIsIn = rooms.length > 0 ? rooms[0] : null;

				// Process each user in the batch
				await Promise.all(
					entityBatch.map(async (entity: Entity) => {
						try {
							await runtime.ensureConnection({
								entityId: entity.id,
								roomId: firstRoomUserIsIn.id,
								userName: entity.metadata[source].username,
								name: entity.metadata[source].name,
								source: source,
								channelId: firstRoomUserIsIn.channelId,
								serverId: world.serverId,
								type: firstRoomUserIsIn.type,
								worldId: world.id,
							});
						} catch (err) {
							logger.warn(
								`Failed to sync user ${entity.metadata.username}: ${err}`,
							);
						}
					}),
				);

				// Add a small delay between batches if not the last batch
				if (i + batchSize < users.length) {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
		}

		logger.success(
			`Successfully synced standardized world structure for ${world.name}`,
		);
	} catch (error) {
		logger.error(
			`Error processing standardized server data: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

const events = {
	MESSAGE_RECEIVED: [
		async ({ runtime, message, callback }: MessageReceivedHandlerParams) => {
			await messageReceivedHandler({
				runtime,
				message,
				callback,
			});
		},
	],
	VOICE_MESSAGE_RECEIVED: [
		async ({ runtime, message, callback }: MessageReceivedHandlerParams) => {
			await messageReceivedHandler({
				runtime,
				message,
				callback,
			});
		},
	],
	REACTION_RECEIVED: [reactionReceivedHandler],

	// Both events now use the same handler function
	SERVER_JOINED: [handleServerSync],
	SERVER_CONNECTED: [handleServerSync],

	USER_JOINED: [
		async ({
			runtime,
			user,
			serverId,
			entityId,
			channelId,
			channelType,
			source,
		}: UserJoinedParams) => {
			await syncSingleUser(
				entityId,
				runtime,
				user,
				serverId,
				channelId,
				channelType,
				source,
			);
		},
	],
};

export const bootstrapPlugin: Plugin = {
	name: "bootstrap",
	description: "Agent bootstrap with basic actions and evaluators",
	actions: [
		followRoomAction,
		unfollowRoomAction,
		ignoreAction,
		noneAction,
		muteRoomAction,
		unmuteRoomAction,
		sendMessageAction,
		updateEntityAction,
		choiceAction,
		updateRoleAction,
		updateSettingsAction,
		replyAction,
	],
	events,
	evaluators: [reflectionEvaluator, goalEvaluator],
	providers: [
		evaluatorsProvider,
		anxietyProvider,
		knowledgeProvider,
		timeProvider,
		characterProvider,
		entitiesProvider,
		relationshipsProvider,
		choiceProvider,
		factsProvider,
		roleProvider,
		settingsProvider,
		capabilitiesProvider,
		attachmentsProvider,
		providersProvider,
		actionsProvider,
		recentMessagesProvider,
	],
	services: [TaskService, ScenarioService],
};

export default bootstrapPlugin;

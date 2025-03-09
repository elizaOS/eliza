import type { UUID } from "node:crypto";
import { v4 } from "uuid";
import { choiceAction } from "./actions/choice";
import { followRoomAction } from "./actions/followRoom";
import { ignoreAction } from "./actions/ignore";
import { muteRoomAction } from "./actions/muteRoom";
import { noneAction } from "./actions/none";
import { replyAction } from "./actions/reply";
import updateRoleAction from "./actions/roles";
import { sendMessageAction } from "./actions/sendMessage";
import updateSettingsAction from "./actions/settings";
import { unfollowRoomAction } from "./actions/unfollowRoom";
import { unmuteRoomAction } from "./actions/unmuteRoom";
import { updateEntityAction } from "./actions/updateEntity";
import { createUniqueUuid } from "./entities";
import { goalAction } from "./actions/goal";
import { reflectionEvaluator } from "./evaluators/reflection";
import { logger } from "./logger";
import {
	composePromptFromState,
	messageHandlerTemplate,
	parseJSONObjectFromText,
	shouldRespondTemplate,
} from "./prompts";
import { actionsProvider } from "./providers/actions";
import { anxietyProvider } from "./providers/anxiety";
import { attachmentsProvider } from "./providers/attachments";
import { capabilitiesProvider } from "./providers/capabilities";
import { characterProvider } from "./providers/character";
import { choiceProvider } from "./providers/choice";
import { entitiesProvider } from "./providers/entities";
import { evaluatorsProvider } from "./providers/evaluators";
import { factsProvider } from "./providers/facts";
import { knowledgeProvider } from "./providers/knowledge";
import { providersProvider } from "./providers/providers";
import { recentMessagesProvider } from "./providers/recentMessages";
import { relationshipsProvider } from "./providers/relationships";
import { roleProvider } from "./providers/roles";
import { settingsProvider } from "./providers/settings";
import { timeProvider } from "./providers/time";
import { ScenarioService } from "./services/scenario";
import { TaskService } from "./services/task";
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
} from "./types";

/**
 * Represents the parameters passed when a server is joined.
 * @typedef {Object} ServerJoinedParams
 * @property {IAgentRuntime} runtime - The agent runtime object.
 * @property {any} world - The platform-specific server object.
 * @property {string} source - The source platform of the server (e.g. "discord", "telegram").
 */
type ServerJoinedParams = {
	runtime: IAgentRuntime;
	world: any; // Platform-specific server object
	source: string; // "discord", "telegram", etc.
};

// Add this to your types.ts file
/**
 * Represents the parameters required when a server is connected.
 * @typedef { Object } ServerConnectedParams
 * @property { IAgentRuntime } runtime - The runtime of the agent.
 * @property { World } world - The world connected to the server.
 * @property {Room[]} rooms - The array of rooms connected to the server.
 * @property {Entity[]} users - The array of users connected to the server.
 * @property { string } source - The source of the connection.
 */
type ServerConnectedParams = {
	runtime: IAgentRuntime;
	world: World;
	rooms: Room[];
	users: Entity[];
	source: string;
};

/**
 * Represents the parameters when a user joins a server.
 * @typedef {Object} UserJoinedParams
 * @property {IAgentRuntime} runtime - The runtime object for the agent.
 * @property {any} user - The user who joined.
 * @property {string} serverId - The ID of the server the user joined.
 * @property {UUID} entityId - The entity ID of the user.
 * @property {string} channelId - The ID of the channel the user joined.
 * @property {ChannelType} channelType - The type of channel the user joined.
 * @property {string} source - The source of the user joining.
 */
type UserJoinedParams = {
	runtime: IAgentRuntime;
	user: any;
	serverId: string;
	entityId: UUID;
	channelId: string;
	channelType: ChannelType;
	source: string;
};

/**
 * Represents the parameters for a message received handler.
 * @typedef {Object} MessageReceivedHandlerParams
 * @property {IAgentRuntime} runtime - The agent runtime associated with the message.
 * @property {Memory} message - The message received.
 * @property {HandlerCallback} callback - The callback function to be executed after handling the message.
 */
type MessageReceivedHandlerParams = {
	runtime: IAgentRuntime;
	message: Memory;
	callback: HandlerCallback;
};

const latestResponseIds = new Map<string, Map<string, string>>();

/**
 * Handles incoming messages and generates responses based on the provided runtime and message information.
 *
 * @param {MessageReceivedHandlerParams} params - The parameters needed for message handling, including runtime, message, and callback.
 * @returns {Promise<void>} - A promise that resolves once the message handling and response generation is complete.
 */
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

	const shouldRespondPrompt = composePromptFromState({
		state,
		template:
			runtime.character.templates?.shouldRespondTemplate ||
			shouldRespondTemplate,
	});

	logger.debug(
		`*** Should Respond Prompt for ${runtime.character.name} ***`,
		shouldRespondPrompt,
	);

	const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
		prompt: shouldRespondPrompt,
	});

	logger.debug(
		`*** Should Respond Response for ${runtime.character.name} ***`,
		response,
	);

	const responseObject = parseJSONObjectFromText(response);

	const providers = responseObject.providers;

	const shouldRespond =
		responseObject?.action && responseObject.action === "RESPOND";

	state = await runtime.composeState(message, null, providers);

	let responseMessages: Memory[] = [];

	if (shouldRespond) {
		const prompt = composePromptFromState({
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

/**
 * Handles the receipt of a reaction message and creates a memory in the designated memory manager.
 *
 * @param {Object} params - The parameters for the function.
 * @param {IAgentRuntime} params.runtime - The agent runtime object.
 * @param {Memory} params.message - The reaction message to be stored in memory.
 * @returns {void}
 */
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
/**
 * Asynchronously sync a single user with the specified parameters.
 *
 * @param {UUID} entityId - The unique identifier for the entity.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {any} user - The user object to sync.
 * @param {string} serverId - The unique identifier for the server.
 * @param {string} channelId - The unique identifier for the channel.
 * @param {ChannelType} type - The type of channel.
 * @param {string} source - The source of the user data.
 * @returns {Promise<void>} A promise that resolves once the user is synced.
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
		replyAction,
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
	],
	events,
	evaluators: [reflectionEvaluator, goalAction],
	providers: [
		evaluatorsProvider,
		anxietyProvider,
		knowledgeProvider,
		timeProvider,
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
		characterProvider,
		recentMessagesProvider,
	],
	services: [TaskService, ScenarioService],
};

export default bootstrapPlugin;

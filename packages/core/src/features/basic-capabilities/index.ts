/**
 * Basic Capabilities
 *
 * Core functionality included by default as basic capabilities.
 * These provide essential agent behavior:
 * - Core providers (actions, character, entities, messages, etc.)
 * - Basic actions (reply, ignore, none)
 * - Essential services (task management, embeddings, trajectory logging)
 * - Event handlers for runtime events
 * - Plugin creation utilities
 */

import { v4 } from "uuid";
import { withCanonicalActionDocs } from "../../action-docs.ts";
import { createUniqueUuid } from "../../entities.ts";
import { logger } from "../../logger.ts";
import {
	imageDescriptionTemplate,
	messageHandlerTemplate,
	postCreationTemplate,
} from "../../prompts.ts";
import { EmbeddingGenerationService } from "../../services/embedding.ts";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptService,
} from "../../services/optimized-prompt.ts";
import { resolveOptimizedPrompt } from "../../services/optimized-prompt-resolver.ts";
import { TaskService } from "../../services/task.ts";
import { isExplicitSelfModificationRequest } from "../../should-respond.ts";
import type { Role } from "../../types/environment.ts";
import { EventType } from "../../types/events.ts";
import type {
	ActionEventPayload,
	ActionLogBody,
	BaseLogBody,
	Content,
	ControlMessagePayload,
	EntityPayload,
	Evaluator,
	EvaluatorEventPayload,
	IAgentRuntime,
	IMessageBusService,
	InvokePayload,
	Media,
	Memory,
	MentionContext,
	MessageMetadata,
	MessagePayload,
	Plugin,
	PluginEvents,
	Room,
	RunEventPayload,
	UUID,
	WorldPayload,
} from "../../types/index.ts";
import { MemoryType } from "../../types/memory.ts";
import { ModelType } from "../../types/model.ts";
import type { ServiceClass } from "../../types/plugin.ts";
import { ChannelType, ContentType } from "../../types/primitives.ts";
import {
	composePromptFromState,
	getLocalServerUrl,
	parseJSONObjectFromText,
} from "../../utils.ts";
import * as autonomy from "../autonomy/index.ts";

const ROLE_OWNER: Role = "OWNER";

// Re-export action and provider modules
export * from "./actions/index.ts";
export * from "./providers/index.ts";

// Import advanced capabilities
import {
	advancedActions,
	advancedCapabilities,
	advancedEvaluators,
	advancedProviders,
	advancedServices,
} from "../advanced-capabilities/index.ts";
// Import core capabilities (trust, secrets, plugin-manager)
import {
	pluginManagerCapability,
	secretsCapability,
	trustCapability,
} from "../index.ts";
// Import for local use
import * as actions from "./actions/index.ts";
import * as providers from "./providers/index.ts";

// Re-export advanced capability modules
export * from "../advanced-capabilities/actions/index.ts";
export * from "../advanced-capabilities/evaluators/index.ts";
// Re-export advanced capabilities
export {
	advancedActions,
	advancedCapabilities,
	advancedEvaluators,
	advancedProviders,
	advancedServices,
} from "../advanced-capabilities/index.ts";
export * from "../advanced-capabilities/providers/index.ts";
// Re-export autonomy
export * from "../autonomy/index.ts";
// Re-export core capabilities (trust, secrets, plugin-manager)
export {
	coreCapabilities,
	pluginManagerCapability,
	secretsCapability,
	trustCapability,
} from "../index.ts";
// Re-export plugin-manager security helpers (used by other plugins like
// plugin-app-control to gate owner/admin-only actions without taking a dep
// on @elizaos/agent, which would create a layer cycle).
export {
	createPluginAction,
	hasAdminAccess,
	hasOwnerAccess,
	type PluginMode,
	pluginAction,
	type SecurityDeps,
} from "../plugin-manager/index.ts";

// ============================================================================
// Structured TOON response interfaces.
// ============================================================================

interface ImageDescriptionToon {
	description?: string;
	title?: string;
	text?: string;
}

interface MessageHandlerToon {
	thought?: string;
	actions?: string | string[];
	providers?: string | string[];
	text?: string;
	simple?: boolean;
}

interface PostCreationToon {
	post?: string;
	thought?: string;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsAgentName(
	text: string | undefined,
	names: Array<string | null | undefined>,
): boolean {
	if (!text) {
		return false;
	}

	const safeText = text.length > 10_000 ? text.slice(0, 10_000) : text;
	return names.some((name) => {
		const candidate = name?.trim();
		if (!candidate) {
			return false;
		}

		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		return pattern.test(safeText);
	});
}

function textContainsUserTag(text: string | undefined): boolean {
	if (!text) {
		return false;
	}

	const safeText = text.length > 10_000 ? text.slice(0, 10_000) : text;
	return /<@!?[^>]+>|@\w+/u.test(safeText);
}

// ============================================================================
// Utility Functions
// ============================================================================

type MediaData = {
	data: Buffer;
	mediaType: string;
};

export async function fetchMediaData(
	attachments: Media[],
): Promise<MediaData[]> {
	return Promise.all(
		attachments.map(async (attachment: Media) => {
			if (/^(http|https):\/\//.test(attachment.url)) {
				const response = await fetch(attachment.url);
				if (!response.ok) {
					throw new Error(`Failed to fetch file: ${attachment.url}`);
				}
				const mediaBuffer = Buffer.from(await response.arrayBuffer());
				const mediaType = attachment.contentType || "image/png";
				return { data: mediaBuffer, mediaType };
			}
			throw new Error(
				`File not found: ${attachment.url}. Make sure the path is correct.`,
			);
		}),
	);
}

/**
 * Processes attachments by generating descriptions for supported media types.
 * Currently supports image description generation.
 *
 * @param {Media[]} attachments - Array of attachments to process
 * @param {IAgentRuntime} runtime - The agent runtime for accessing AI models
 * @returns {Promise<Media[]>} - Returns a new array of processed attachments with added description, title, and text properties
 */
export async function processAttachments(
	attachments: Media[] | null | undefined,
	runtime: IAgentRuntime,
): Promise<Media[]> {
	if (!attachments || attachments.length === 0) {
		return [];
	}
	runtime.logger.debug(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			count: attachments.length,
		},
		"Processing attachments",
	);

	const processedAttachments: Media[] = [];

	for (const attachment of attachments) {
		const processedAttachment: Media = { ...attachment };

		const isRemote = /^(http|https):\/\//.test(attachment.url);
		const url = isRemote ? attachment.url : getLocalServerUrl(attachment.url);
		if (
			attachment.contentType === ContentType.IMAGE &&
			!attachment.description
		) {
			runtime.logger.debug(
				{
					src: "basic-capabilities",
					agentId: runtime.agentId,
					url: attachment.url,
				},
				"Generating description for image",
			);

			let imageUrl = url;

			if (!isRemote) {
				const res = await fetch(url);
				if (!res.ok) {
					throw new Error(`Failed to fetch image: ${res.statusText}`);
				}

				const arrayBuffer = await res.arrayBuffer();
				const buffer = Buffer.from(arrayBuffer);
				const contentType =
					res.headers.get("content-type") || "application/octet-stream";
				imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
			}

			let response: string | object | undefined;
			try {
				const optimizedMediaService =
					runtime.getService<OptimizedPromptService>(OPTIMIZED_PROMPT_SERVICE);
				const resolvedImageDescriptionPrompt = resolveOptimizedPrompt(
					optimizedMediaService,
					"media_description",
					imageDescriptionTemplate,
				);
				response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
					prompt: resolvedImageDescriptionPrompt,
					imageUrl,
				});
			} catch (err) {
				runtime.logger.error(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Error generating image description",
				);
				// Continue with original attachment on error
				processedAttachments.push(processedAttachment);
				continue;
			}

			if (typeof response === "string") {
				const parsedJson = parseJSONObjectFromText(
					response,
				) as ImageDescriptionToon | null;

				if (parsedJson && (parsedJson.description || parsedJson.text)) {
					processedAttachment.description = parsedJson.description ?? "";
					processedAttachment.title = parsedJson.title ?? "Image";
					processedAttachment.text =
						parsedJson.text ?? parsedJson.description ?? "";

					runtime.logger.debug(
						{
							src: "basic-capabilities",
							agentId: runtime.agentId,
							descriptionPreview:
								processedAttachment.description?.substring(0, 100) || undefined,
						},
						"Generated description",
					);
				} else {
					runtime.logger.warn(
						{ src: "basic-capabilities", agentId: runtime.agentId },
						"Failed to parse TOON response for image description",
					);
				}
			} else if (
				response &&
				typeof response === "object" &&
				"description" in response
			) {
				// Handle object responses for backwards compatibility
				const responseObj = response as {
					description?: string;
					title?: string;
				};
				processedAttachment.description = responseObj.description;
				processedAttachment.title = responseObj.title || "Image";
				processedAttachment.text = responseObj.description;

				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						descriptionPreview:
							processedAttachment.description?.substring(0, 100) || undefined,
					},
					"Generated description",
				);
			} else {
				runtime.logger.warn(
					{ src: "basic-capabilities", agentId: runtime.agentId },
					"Unexpected response format for image description",
				);
			}
		} else if (
			attachment.contentType === ContentType.DOCUMENT &&
			!attachment.text
		) {
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`Failed to fetch document: ${res.statusText}`);
			}

			const contentType = res.headers.get("content-type") || "";
			const isPlainText = contentType.startsWith("text/plain");

			if (isPlainText) {
				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						url: attachment.url,
					},
					"Processing plain text document",
				);

				const textContent = await res.text();
				processedAttachment.text = textContent;
				processedAttachment.title = processedAttachment.title || "Text File";

				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						textPreview:
							processedAttachment.text?.substring(0, 100) || undefined,
					},
					"Extracted text content",
				);
			} else {
				runtime.logger.warn(
					{ src: "basic-capabilities", agentId: runtime.agentId, contentType },
					"Skipping non-plain-text document",
				);
			}
		}

		processedAttachments.push(processedAttachment);
	}

	return processedAttachments;
}

export function shouldRespond(
	runtime: IAgentRuntime,
	message: Memory,
	room?: Room,
	mentionContext?: MentionContext,
): { shouldRespond: boolean; skipEvaluation: boolean; reason: string } {
	if (!room) {
		return {
			shouldRespond: false,
			skipEvaluation: true,
			reason: "no room context",
		};
	}

	function normalizeEnvList(value: unknown): string[] {
		if (!value || typeof value !== "string") {
			return [];
		}
		const cleaned = value.trim().replace(/^[[]|[\]]$/g, "");
		return cleaned
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	}

	const alwaysRespondChannels = [
		ChannelType.DM,
		ChannelType.VOICE_DM,
		ChannelType.SELF,
		ChannelType.API,
	];

	const alwaysRespondSources = ["client_chat"];

	const customChannels = normalizeEnvList(
		runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ??
			runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
	);
	const customSources = normalizeEnvList(
		runtime.getSetting("ALWAYS_RESPOND_SOURCES") ??
			runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"),
	);

	const respondChannels = new Set(
		[...alwaysRespondChannels.map((t) => t.toString()), ...customChannels].map(
			(s: string) => s.trim().toLowerCase(),
		),
	);

	const respondSources = [...alwaysRespondSources, ...customSources].map(
		(s: string) => s.trim().toLowerCase(),
	);

	const roomType = room.type?.toString().toLowerCase() || undefined;
	const messageContentSource = message.content.source;
	const sourceStr = messageContentSource?.toLowerCase() || "";
	const textMentionsAgentByName =
		textContainsUserTag(message.content.text) &&
		textContainsAgentName(message.content.text, [
			runtime.character.name,
			runtime.character.username,
		]);

	// 1. DM/VOICE_DM/API channels: always respond (private channels)
	if (roomType && respondChannels.has(roomType)) {
		return {
			shouldRespond: true,
			skipEvaluation: true,
			reason: `private channel: ${roomType}`,
		};
	}

	// 2. Specific sources (e.g., client_chat): always respond
	if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
		return {
			shouldRespond: true,
			skipEvaluation: true,
			reason: `whitelisted source: ${sourceStr}`,
		};
	}

	// 3. Platform mentions and replies: always respond
	// This is the key feature from mentionContext - platform-detected mentions/replies
	const mentionContextIsMention = mentionContext?.isMention;
	const mentionContextIsReply = mentionContext?.isReply;
	const hasPlatformMention = !!(
		mentionContextIsMention || mentionContextIsReply
	);
	if (hasPlatformMention) {
		const mentionType = mentionContextIsMention ? "mention" : "reply";
		return {
			shouldRespond: true,
			skipEvaluation: true,
			reason: `platform ${mentionType}`,
		};
	}

	// 4. Mixed-address messages should still reach the agent when the text
	// explicitly names it alongside other user tags.
	if (textMentionsAgentByName) {
		return {
			shouldRespond: true,
			skipEvaluation: true,
			reason: "text address with tagged participants",
		};
	}

	// 5. Clear self-modification requests should bypass the ignore-biased
	// classifier even in group chat, but only for narrow personality/style
	// update phrasing to avoid broad false positives.
	if (isExplicitSelfModificationRequest(message.content.text || "")) {
		return {
			shouldRespond: true,
			skipEvaluation: true,
			reason: "explicit self-modification request",
		};
	}

	// 6. All other cases: let the LLM decide
	// The LLM will handle: indirect questions, conversation context, etc.
	return {
		shouldRespond: false,
		skipEvaluation: false,
		reason: "needs LLM evaluation",
	};
}

// ============================================================================
// Event Handlers
// ============================================================================

const reactionReceivedHandler = async ({
	runtime,
	message,
}: {
	runtime: IAgentRuntime;
	message: Memory;
}) => {
	await runtime.createMemories([{ memory: message, tableName: "messages" }]);
};

const postGeneratedHandler = async ({
	runtime,
	callback,
	worldId,
	userId,
	roomId,
	source,
}: InvokePayload) => {
	const safeSource = source ?? "unknown";
	const safeUserId = (userId ?? runtime.agentId) as UUID;

	runtime.logger.info(
		{ src: "basic-capabilities", agentId: runtime.agentId },
		"Generating new post",
	);
	// Ensure world exists first
	await runtime.ensureWorldExists({
		id: worldId,
		name: `${runtime.character.name}'s Feed`,
		agentId: runtime.agentId,
		messageServerId: safeUserId,
	});

	await runtime.ensureRoomExists({
		id: roomId,
		name: `${runtime.character.name}'s Feed`,
		source: safeSource,
		type: ChannelType.FEED,
		channelId: `${safeUserId}-home`,
		messageServerId: safeUserId,
		worldId,
	});

	const message: Memory = {
		id: createUniqueUuid(runtime, `post-${Date.now()}`) as UUID,
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: roomId as UUID,
		content: {} as Content,
		metadata: {
			entityName: runtime.character.name,
			type: MemoryType.MESSAGE,
		} as MessageMetadata & { entityName: string },
	};

	// generate thought of which providers to use using messageHandlerTemplate

	// Compose state with relevant context for post generation
	let state = await runtime.composeState(message, [
		"PROVIDERS",
		"CHARACTER",
		"RECENT_MESSAGES",
		"ENTITIES",
	]);

	const entity = (await runtime.getEntitiesByIds([runtime.agentId]))[0] ?? null;
	interface XMetadata {
		x?: {
			userName?: string;
		};
		userName?: string;
	}
	const entityMetadata = entity?.metadata;
	const metadata = entityMetadata as XMetadata | undefined;
	const metadataX = metadata?.x;
	if (metadataX?.userName || metadata?.userName) {
		state.values.xUserName =
			metadataX?.userName || metadata?.userName || undefined;
	}

	const optimizedResponseService = runtime.getService<OptimizedPromptService>(
		OPTIMIZED_PROMPT_SERVICE,
	);
	const dynamicPrompt = await runtime.getCache<string>(
		"core_prompt_messageHandlerTemplate",
	);
	const baselineResponseTemplate =
		dynamicPrompt ||
		runtime.character.templates?.messageHandlerTemplate ||
		messageHandlerTemplate;
	const prompt = composePromptFromState({
		state,
		template: resolveOptimizedPrompt(
			optimizedResponseService,
			"response",
			baselineResponseTemplate,
		),
	});

	let responseContent: Content | null = null;

	let retries = 0;
	const maxRetries = 3;
	while (
		retries < maxRetries &&
		(!responseContent?.thought || !responseContent?.actions)
	) {
		const response = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
		});

		const parsedJson = parseJSONObjectFromText(
			response,
		) as MessageHandlerToon | null;
		if (parsedJson) {
			const actionsRaw = parsedJson.actions;
			const providersRaw = parsedJson.providers;
			const resolvedActions = Array.isArray(actionsRaw)
				? actionsRaw
				: actionsRaw
					? actionsRaw
							.split(",")
							.map((action) => action.trim())
							.filter(Boolean)
					: ["IGNORE"];
			responseContent = {
				thought: parsedJson.thought ?? "",
				actions: resolvedActions.length > 0 ? resolvedActions : ["IGNORE"],
				providers: Array.isArray(providersRaw)
					? providersRaw
					: providersRaw
						? [providersRaw]
						: [],
				text: parsedJson.text ?? "",
				simple: parsedJson.simple ?? false,
			};
		} else {
			responseContent = null;
		}

		retries++;
		const responseContentThoughtAfter = responseContent?.thought;
		const responseContentActionsAfter = responseContent?.actions;
		if (!responseContentThoughtAfter || !responseContentActionsAfter) {
			runtime.logger.warn(
				{
					src: "basic-capabilities",
					agentId: runtime.agentId,
					response,
					parsedJson,
					responseContent,
				},
				"Missing required fields, retrying",
			);
		}
	}

	const responseContentProviders = responseContent?.providers;
	state = await runtime.composeState(message, responseContentProviders);

	const postPrompt = composePromptFromState({
		state,
		template:
			runtime.character.templates?.postCreationTemplate || postCreationTemplate,
	});

	const structuredResponseText = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt: postPrompt,
	});

	const parsedToonResponse = parseJSONObjectFromText(
		structuredResponseText,
	) as PostCreationToon | null;

	if (!parsedToonResponse) {
		runtime.logger.error(
			{
				src: "basic-capabilities",
				agentId: runtime.agentId,
				structuredResponseText,
			},
			"Failed to parse structured response for post creation",
		);
		throw new Error("Failed to parse structured response for post creation");
	}

	function cleanupPostText(text: string): string {
		let cleanedText = text.replace(/^['"](.*)['"]$/, "$1");
		cleanedText = cleanedText.replaceAll(/\\n/g, "\n\n");
		cleanedText = cleanedText.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
		return cleanedText;
	}

	const cleanedText = cleanupPostText(parsedToonResponse.post ?? "");
	const stateData = state.data;
	const stateDataProviders = stateData?.providers;
	const RM =
		stateDataProviders &&
		(stateDataProviders.RECENT_MESSAGES as
			| { data?: { recentMessages?: Array<{ content: { text?: string } }> } }
			| undefined);
	const RMData = RM?.data;
	const RMDataRecentMessages = RMData?.recentMessages;
	if (RMDataRecentMessages) {
		for (const m of RMDataRecentMessages) {
			if (cleanedText === m.content.text) {
				runtime.logger.info(
					{ src: "basic-capabilities", agentId: runtime.agentId, cleanedText },
					"Already recently posted that, retrying",
				);
				postGeneratedHandler({
					runtime,
					callback,
					worldId,
					userId,
					roomId,
					source,
				});
				return; // don't call callbacks
			}
		}
	}

	// GPT 3.5/4: /(i\s+do\s+not|i'?m\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content|(inappropriate|explicit|offensive|communicate\s+respectfully|aim\s+to\s+(be\s+)?helpful)/i
	const oaiRefusalRegex =
		/((i\s+do\s+not|i'm\s+not)\s+(feel\s+)?comfortable\s+generating\s+that\s+type\s+of\s+content)|(inappropriate|explicit|respectful|offensive|guidelines|aim\s+to\s+(be\s+)?helpful|communicate\s+respectfully)/i;
	const anthropicRefusalRegex =
		/(i'?m\s+unable\s+to\s+help\s+with\s+that\s+request|due\s+to\s+safety\s+concerns|that\s+may\s+violate\s+(our\s+)?guidelines|provide\s+helpful\s+and\s+safe\s+responses|let'?s\s+try\s+a\s+different\s+direction|goes\s+against\s+(our\s+)?use\s+case\s+policies|ensure\s+safe\s+and\s+responsible\s+use)/i;
	const googleRefusalRegex =
		/(i\s+can'?t\s+help\s+with\s+that|that\s+goes\s+against\s+(our\s+)?(policy|policies)|i'?m\s+still\s+learning|response\s+must\s+follow\s+(usage|safety)\s+policies|i'?ve\s+been\s+designed\s+to\s+avoid\s+that)/i;
	//const cohereRefusalRegex = /(request\s+cannot\s+be\s+processed|violates\s+(our\s+)?content\s+policy|not\s+permitted\s+by\s+usage\s+restrictions)/i
	const generalRefusalRegex =
		/(response\s+was\s+withheld|content\s+was\s+filtered|this\s+request\s+cannot\s+be\s+completed|violates\s+our\s+safety\s+policy|content\s+is\s+not\s+available)/i;

	if (
		oaiRefusalRegex.test(cleanedText) ||
		anthropicRefusalRegex.test(cleanedText) ||
		googleRefusalRegex.test(cleanedText) ||
		generalRefusalRegex.test(cleanedText)
	) {
		runtime.logger.info(
			{ src: "basic-capabilities", agentId: runtime.agentId, cleanedText },
			"Got prompt moderation refusal, retrying",
		);
		postGeneratedHandler({
			runtime,
			callback,
			worldId,
			userId,
			roomId,
			source,
		});
		return; // don't call callbacks
	}

	// Create the response memory
	const responseMessages = [
		{
			id: v4() as UUID,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			content: {
				text: cleanedText,
				source,
				channelType: ChannelType.FEED,
				thought: parsedToonResponse.thought ?? "",
				type: "post",
			},
			roomId: message.roomId,
			createdAt: Date.now(),
		},
	];

	for (const message of responseMessages) {
		if (callback) {
			await callback(message.content);
		}
	}
};

/**
 * Syncs a single user into an entity
 */
const syncSingleUser = async (
	entityId: UUID,
	runtime: IAgentRuntime,
	messageServerId: UUID,
	channelId: string,
	type: ChannelType,
	source: string,
) => {
	const entity = (await runtime.getEntitiesByIds([entityId]))[0] ?? null;
	runtime.logger.info(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			entityId,
			username: entity?.metadata?.username || undefined,
		},
		"Syncing user",
	);

	// Ensure we're not using WORLD type and that we have a valid channelId
	if (!channelId) {
		runtime.logger.warn(
			{
				src: "basic-capabilities",
				agentId: runtime.agentId,
				entityId: entity?.id || undefined,
			},
			"Cannot sync user without a valid channelId",
		);
		return;
	}

	const roomId = createUniqueUuid(runtime, channelId);
	const worldId = createUniqueUuid(runtime, messageServerId);

	const worldMetadata =
		type === ChannelType.DM
			? {
					ownership: {
						ownerId: entityId,
					},
					roles: {
						[entityId]: ROLE_OWNER,
					},
					settings: {}, // Initialize empty settings for onboarding
				}
			: undefined;

	runtime.logger.info(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			type,
			isDM: type === ChannelType.DM,
			worldMetadata,
		},
		"syncSingleUser",
	);

	await runtime.ensureConnection({
		entityId,
		roomId,
		name: (entity?.metadata?.name ||
			entity?.metadata?.username ||
			`User${entityId}`) as undefined | string,
		source,
		channelId,
		messageServerId,
		type,
		worldId,
		metadata: worldMetadata,
	});

	const createdWorld = (await runtime.getWorldsByIds([worldId]))[0] ?? null;
	runtime.logger.info(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			worldId,
			metadata: createdWorld?.metadata || undefined,
		},
		"Created world check",
	);

	runtime.logger.success(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			agentName: runtime.character.name,
			entityId: entity?.id || undefined,
		},
		"Successfully synced user",
	);
};

/**
 * Handles standardized server data for both WORLD_JOINED and WORLD_CONNECTED events
 */
const handleServerSync = async ({
	runtime,
	world,
	rooms,
	entities,
	source,
	onComplete,
}: WorldPayload) => {
	runtime.logger.debug(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			serverName: world.name,
		},
		"Handling server sync event",
	);
	const safeSource = source ?? "unknown";
	await runtime.ensureConnections(entities, rooms, safeSource, world);
	runtime.logger.debug(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			worldName: world.name,
		},
		"Successfully synced standardized world structure",
	);
	if (onComplete) {
		onComplete();
	}
};

const controlMessageHandler = async ({
	runtime,
	message,
}: ControlMessagePayload) => {
	runtime.logger.debug(
		{
			src: "basic-capabilities",
			agentId: runtime.agentId,
			action: message.payload.action,
			roomId: message.roomId,
		},
		"Processing control message",
	);

	const serviceNames = Array.from(runtime.getAllServices().keys()) as string[];
	const websocketServiceName = serviceNames.find(
		(name: string) =>
			name.toLowerCase().includes("websocket") ||
			name.toLowerCase().includes("socket"),
	);

	if (websocketServiceName) {
		const websocketService = runtime.getService(websocketServiceName);
		interface WebSocketServiceWithSendMessage {
			sendMessage: (message: {
				type: string;
				payload: unknown;
			}) => Promise<void>;
		}
		if (websocketService && "sendMessage" in websocketService) {
			await (websocketService as WebSocketServiceWithSendMessage).sendMessage({
				type: "controlMessage",
				payload: {
					action: message.payload.action,
					target: message.payload.target,
					roomId: message.roomId,
				},
			});

			runtime.logger.debug(
				{
					src: "basic-capabilities",
					agentId: runtime.agentId,
					action: message.payload.action,
				},
				"Control message sent successfully",
			);
		} else {
			runtime.logger.error(
				{ src: "basic-capabilities", agentId: runtime.agentId },
				"WebSocket service does not have sendMessage method",
			);
		}
	} else {
		runtime.logger.error(
			{ src: "basic-capabilities", agentId: runtime.agentId },
			"No WebSocket service found to send control message",
		);
	}
};

// ============================================================================
// Events Configuration
// ============================================================================

const events: PluginEvents = {
	[EventType.REACTION_RECEIVED]: [
		async (payload: MessagePayload) => {
			await reactionReceivedHandler(payload);
		},
	],

	[EventType.POST_GENERATED]: [
		async (payload: InvokePayload) => {
			await postGeneratedHandler(payload);
		},
	],

	[EventType.MESSAGE_SENT]: [
		async (payload: MessagePayload) => {
			payload.runtime.logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					text: payload.message.content.text,
				},
				"Message sent",
			);
		},
	],

	[EventType.WORLD_JOINED]: [
		async (payload: WorldPayload) => {
			await handleServerSync(payload);
		},
	],

	[EventType.WORLD_CONNECTED]: [
		async (payload: WorldPayload) => {
			await handleServerSync(payload);
		},
	],

	[EventType.ENTITY_JOINED]: [
		async (payload: EntityPayload) => {
			payload.runtime.logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					entityId: payload.entityId,
				},
				"ENTITY_JOINED event received",
			);

			if (!payload.worldId) {
				payload.runtime.logger.error(
					{ src: "basic-capabilities", agentId: payload.runtime.agentId },
					"No worldId provided for entity joined",
				);
				return;
			}
			if (!payload.roomId) {
				payload.runtime.logger.error(
					{ src: "basic-capabilities", agentId: payload.runtime.agentId },
					"No roomId provided for entity joined",
				);
				return;
			}
			const payloadMetadata = payload.metadata;
			if (!payloadMetadata?.type) {
				payload.runtime.logger.error(
					{ src: "basic-capabilities", agentId: payload.runtime.agentId },
					"No type provided for entity joined",
				);
				return;
			}

			const channelType = payloadMetadata?.type;
			if (typeof channelType !== "string") {
				payload.runtime.logger.warn("Missing channel type in entity payload");
				return;
			}
			const safeSource = payload.source ?? "unknown";
			if (!payload.roomId) {
				payload.runtime.logger.warn("Missing roomId in entity payload");
				return;
			}
			await syncSingleUser(
				payload.entityId,
				payload.runtime,
				payload.worldId,
				payload.roomId,
				channelType as ChannelType,
				safeSource,
			);
		},
	],

	[EventType.ENTITY_LEFT]: [
		async (payload: EntityPayload) => {
			// Update entity to inactive
			const entity =
				(await payload.runtime.getEntitiesByIds([payload.entityId]))[0] ?? null;
			if (entity) {
				entity.metadata = {
					...entity.metadata,
					status: "INACTIVE",
					leftAt: Date.now(),
				};
				await payload.runtime.updateEntities([entity]);
			}
			payload.runtime.logger.info(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					entityId: payload.entityId,
					worldId: payload.worldId,
				},
				"User left world",
			);
		},
	],

	[EventType.ACTION_STARTED]: [
		async (payload: ActionEventPayload) => {
			// Only notify for client_chat messages
			const payloadContent = payload.content;
			if (payloadContent && payloadContent.source === "client_chat") {
				const messageBusService =
					payload.runtime.getService<IMessageBusService>("message-bus-service");
				if (messageBusService?.notifyActionStart) {
					await messageBusService.notifyActionStart(
						payload.roomId,
						payload.world,
						payload.content,
						payload.messageId,
					);
				}
			}
		},
		async (payload: ActionEventPayload) => {
			const content = payload.content;
			const contentActions = content?.actions;
			const actionName = contentActions?.[0] ?? "unknown";

			await payload.runtime.createLogs([
				{
					entityId: payload.runtime.agentId,
					roomId: payload.roomId,
					type: "action_event",
					body: {
						runId: (content?.runId as string | undefined) ?? "",
						actionId: (content?.actionId as string | undefined) ?? "",
						actionName: actionName,
						roomId: payload.roomId,
						messageId: payload.messageId,
						timestamp: Date.now(),
						planStep: (content?.planStep as string | undefined) ?? "",
						source: "actionHandler",
					} as ActionLogBody,
				},
			]);
			logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					actionName: actionName,
				},
				"Logged ACTION_STARTED event",
			);
		},
	],

	[EventType.ACTION_COMPLETED]: [
		async (payload: ActionEventPayload) => {
			// Only notify for client_chat messages
			const payloadContent = payload.content;
			if (payloadContent && payloadContent.source === "client_chat") {
				const messageBusService =
					payload.runtime.getService<IMessageBusService>("message-bus-service");
				if (messageBusService?.notifyActionUpdate) {
					await messageBusService.notifyActionUpdate(
						payload.roomId,
						payload.world,
						payload.content,
						payload.messageId,
					);
				}
			}
		},
	],

	[EventType.EVALUATOR_STARTED]: [
		async (payload: EvaluatorEventPayload) => {
			logger.debug(
				{
					src: "basic-capabilities:evaluator",
					agentId: payload.runtime.agentId,
					evaluatorName: payload.evaluatorName,
					evaluatorId: payload.evaluatorId,
				},
				"Evaluator started",
			);
		},
	],

	[EventType.EVALUATOR_COMPLETED]: [
		async (payload: EvaluatorEventPayload) => {
			const status = payload.error ? "failed" : "completed";
			logger.debug(
				{
					src: "basic-capabilities:evaluator",
					agentId: payload.runtime.agentId,
					status,
					evaluatorName: payload.evaluatorName,
					evaluatorId: payload.evaluatorId,
					error: payload.error?.message || undefined,
				},
				"Evaluator completed",
			);
		},
	],

	[EventType.RUN_STARTED]: [
		async (payload: RunEventPayload) => {
			await payload.runtime.createLogs([
				{
					entityId: payload.entityId,
					roomId: payload.roomId,
					type: "run_event",
					body: {
						runId: payload.runId,
						status: payload.status,
						messageId: payload.messageId,
						roomId: payload.roomId,
						entityId: payload.entityId,
						startTime: payload.startTime,
						source: payload.source || "unknown",
					} as BaseLogBody,
				},
			]);
			logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					runId: payload.runId,
				},
				"Logged RUN_STARTED event",
			);
		},
	],

	[EventType.RUN_ENDED]: [
		async (payload: RunEventPayload) => {
			await payload.runtime.createLogs([
				{
					entityId: payload.entityId,
					roomId: payload.roomId,
					type: "run_event",
					body: {
						runId: payload.runId,
						status: payload.status,
						messageId: payload.messageId,
						roomId: payload.roomId,
						entityId: payload.entityId,
						startTime: payload.startTime,
						endTime: payload.endTime,
						duration: payload.duration,
						error: payload.error,
						source: payload.source || "unknown",
					} as BaseLogBody,
				},
			]);
			logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					runId: payload.runId,
					status: payload.status,
				},
				"Logged RUN_ENDED event",
			);
		},
	],

	[EventType.RUN_TIMEOUT]: [
		async (payload: RunEventPayload) => {
			await payload.runtime.createLogs([
				{
					entityId: payload.entityId,
					roomId: payload.roomId,
					type: "run_event",
					body: {
						runId: payload.runId,
						status: payload.status,
						messageId: payload.messageId,
						roomId: payload.roomId,
						entityId: payload.entityId,
						startTime: payload.startTime,
						endTime: payload.endTime,
						duration: payload.duration,
						error: payload.error,
						source: payload.source || "unknown",
					} as BaseLogBody,
				},
			]);
			logger.debug(
				{
					src: "basic-capabilities",
					agentId: payload.runtime.agentId,
					runId: payload.runId,
				},
				"Logged RUN_TIMEOUT event",
			);
		},
	],

	[EventType.CONTROL_MESSAGE]: [
		async (payload: ControlMessagePayload) => {
			if (!payload.message) {
				payload.runtime.logger.warn(
					{ src: "basic-capabilities" },
					"CONTROL_MESSAGE received without message property",
				);
				return;
			}
			await controlMessageHandler(payload);
		},
	],
};

// ============================================================================
// Basic Capabilities
// ============================================================================

/**
 * Basic providers - core functionality for agent operation
 */
export const basicProviders = [
	providers.actionsProvider,
	providers.actionStateProvider,
	providers.attachmentsProvider,
	providers.characterProvider,
	providers.choiceProvider,
	providers.contextBenchProvider,
	providers.currentTimeProvider,
	providers.entitiesProvider,
	providers.evaluatorsProvider,
	providers.platformChatContextProvider,
	providers.platformUserContextProvider,
	providers.providersProvider,
	providers.recentMessagesProvider,
	providers.uiContextProvider,
	providers.worldProvider,
];

/**
 * Basic actions - fundamental response actions
 */
export const basicActions = [
	withCanonicalActionDocs(actions.choiceAction),
	withCanonicalActionDocs(actions.replyAction),
	withCanonicalActionDocs(actions.ignoreAction),
	withCanonicalActionDocs(actions.noneAction),
];

/**
 * Basic evaluators - none by default (evaluators are typically advanced features)
 */
export const basicEvaluators: never[] = [];

/**
 * Basic services - essential infrastructure services
 */
export const basicServices: ServiceClass[] = [
	TaskService,
	EmbeddingGenerationService,
];

/**
 * Combined basic capabilities object
 */
export const basicCapabilities = {
	providers: basicProviders,
	actions: basicActions,
	evaluators: basicEvaluators,
	services: basicServices,
};

// ============================================================================
// Capability Configuration
// ============================================================================

/**
 * Configuration for basic capabilities.
 * - Basic: Core functionality (reply, ignore, none actions; core providers; task/embedding services)
 * - Advanced/Extended: Additional features (choice, mute/follow room, roles, settings, image generation)
 * - Autonomy: Autonomous operation (autonomy service, admin communication, status providers)
 *
 * @see basic-capabilities for basic capability definitions
 * @see advanced-capabilities for advanced capability definitions
 */
export interface CapabilityConfig {
	/** Disable basic capabilities (default: false) */
	disableBasic?: boolean;
	/** Enable extended/advanced capabilities (default: false) */
	enableExtended?: boolean;
	/** Alias for enableExtended - Enable advanced capabilities (default: false) */
	advancedCapabilities?: boolean;
	/** Skip the character provider (used for anonymous agents without a character file) */
	skipCharacterProvider?: boolean;
	/** Enable autonomy capabilities (default: false) */
	enableAutonomy?: boolean;
	/** Enable trust engine, security, and permissions (default: false) */
	enableTrust?: boolean;
	/** Enable encrypted secrets management and dynamic plugin activation (default: false) */
	enableSecretsManager?: boolean;
	/** Enable plugin introspection, install/eject/sync (default: false) */
	enablePluginManager?: boolean;
}

// Autonomy capabilities - opt-in
// Provides autonomous operation with continuous agent thinking loop
const autonomyCapabilities = {
	providers: [autonomy.adminChatProvider, autonomy.autonomyStatusProvider],
	actions: [withCanonicalActionDocs(autonomy.sendToAdminAction)],
	evaluators: [] as Evaluator[],
	services: [autonomy.AutonomyService] as ServiceClass[],
	routes: autonomy.autonomyRoutes,
};

// Legacy alias exports for backwards compatibility
export { advancedCapabilities as extendedCapabilities, autonomyCapabilities };

/**
 * Creates the basic-capabilities plugin with the specified capability configuration.
 * This is the main entry point for plugin creation.
 */
export function createBasicCapabilitiesPlugin(
	config: CapabilityConfig = {},
): Plugin {
	// Support both enableExtended and advancedCapabilities as aliases
	const useAdvanced = config.enableExtended || config.advancedCapabilities;

	const filteredBasicProviders = config.skipCharacterProvider
		? basicProviders.filter((p) => p.name !== "CHARACTER")
		: basicProviders;

	// Build init chain for core capabilities that need initialization
	const initFns: Array<(runtime: IAgentRuntime) => Promise<void>> = [];
	if (config.enableTrust) {
		initFns.push(trustCapability.init);
	}

	return {
		name: "basic-capabilities",
		description: "Agent basic capabilities with core actions and evaluators",
		actions: [
			...(config.disableBasic ? [] : basicActions),
			...(useAdvanced ? advancedActions : []),
			...(config.enableAutonomy ? autonomyCapabilities.actions : []),
			...(config.enableTrust ? trustCapability.actions : []),
			...(config.enableSecretsManager ? secretsCapability.actions : []),
			...(config.enablePluginManager ? pluginManagerCapability.actions : []),
		],
		providers: [
			...(config.disableBasic ? [] : filteredBasicProviders),
			...(useAdvanced ? advancedProviders : []),
			...(config.enableAutonomy ? autonomyCapabilities.providers : []),
			...(config.enableTrust ? trustCapability.providers : []),
			...(config.enableSecretsManager ? secretsCapability.providers : []),
			...(config.enablePluginManager ? pluginManagerCapability.providers : []),
		],
		evaluators: [
			...(config.disableBasic ? [] : basicEvaluators),
			...(useAdvanced ? advancedEvaluators : []),
			...(config.enableAutonomy ? autonomyCapabilities.evaluators : []),
		],
		services: [
			...(config.disableBasic ? [] : basicServices),
			...(useAdvanced ? advancedServices : []),
			...(config.enableAutonomy ? autonomyCapabilities.services : []),
			...(config.enableTrust ? trustCapability.services : []),
			...(config.enableSecretsManager ? secretsCapability.services : []),
			...(config.enablePluginManager ? pluginManagerCapability.services : []),
		],
		routes: [...(config.enableAutonomy ? autonomyCapabilities.routes : [])],
		events,
		...(initFns.length > 0
			? {
					init: async (
						_config: Record<string, string>,
						runtime: IAgentRuntime,
					) => {
						for (const fn of initFns) {
							await fn(runtime);
						}
					},
				}
			: {}),
	};
}

export default basicCapabilities;

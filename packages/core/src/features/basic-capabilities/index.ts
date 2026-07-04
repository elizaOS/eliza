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
import { fetchWithSsrfGuard } from "../../network/index.ts";
import {
	imageDescriptionTemplate,
	postCreationTemplate,
} from "../../prompts.ts";
import {
	getConfiguredOwnerEntityIds,
	type RolesWorldMetadata,
	recordOwnerGrant,
} from "../../roles.ts";
import { TURN_CONTROL_ROUTES } from "../../runtime/turn-routes";
import { SensitiveRequestDispatchRegistryService } from "../../sensitive-requests/dispatch-registry.ts";
import {
	bridgeActionCompletedToStreams,
	bridgeActionStartedToStreams,
	bridgeConnectorMessageReceivedToStreams,
	bridgeEvaluatorCompletedToStreams,
	bridgeEvaluatorStartedToStreams,
	bridgeMessageReceivedToStreams,
	bridgeRunEndedToStreams,
	bridgeRunStartedToStreams,
	CONNECTOR_MESSAGE_RECEIVED_EVENT_TYPES,
} from "../../services/agent-event-bridge.ts";
import { ChannelTopicsService } from "../../services/channel-topics.ts";
import { EmbeddingGenerationService } from "../../services/embedding.ts";
import { EvaluatorService } from "../../services/evaluator.ts";
import { OptimizedPromptService } from "../../services/optimized-prompt.ts";
import { resolveOptimizedPromptForRuntime } from "../../services/optimized-prompt-resolver.ts";
import { TaskService } from "../../services/task.ts";
import { EventType } from "../../types/events.ts";
import type {
	ActionEventPayload,
	ActionLogBody,
	BaseLogBody,
	Content,
	ControlMessagePayload,
	EntityPayload,
	EvaluatorEventPayload,
	EventPayload,
	IAgentRuntime,
	IControlTransportService,
	IMessageBusService,
	InvokePayload,
	Media,
	Memory,
	MentionContext,
	MessageMetadata,
	MessagePayload,
	Plugin,
	PluginEvents,
	RegisteredEvaluator,
	Room,
	RunEventPayload,
	UUID,
	WorldPayload,
} from "../../types/index.ts";
import { MemoryType } from "../../types/memory.ts";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "../../types/message-source.ts";
import { ModelType } from "../../types/model.ts";
import type { ServiceClass } from "../../types/plugin.ts";
import {
	ChannelType,
	ContentType,
	type JsonValue,
} from "../../types/primitives.ts";
import { ServiceType } from "../../types/service.ts";
import {
	composePromptFromState,
	getLocalServerUrl,
	parseJSONObjectFromText,
} from "../../utils.ts";
// Direct leaf imports — see comment in
// ../advanced-capabilities/index.ts for the Bun.build mis-rewrite that
// requires bypassing barrels here too.
import {
	disableAutonomousModeAction,
	enableAutonomousModeAction,
	escalateAction,
} from "../autonomy/action.ts";
import {
	adminChatProvider,
	autonomyStatusProvider,
} from "../autonomy/providers.ts";
import { autonomyRoutes } from "../autonomy/routes.ts";
import { AutonomyService } from "../autonomy/service.ts";

// Re-export action and provider modules
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
// Generic scheduled-prompt TaskWorker (registered automatically by TaskService).
export {
	PROMPT_RUNNER_TASK_KIND,
	PROMPT_RUNNER_TASK_WORKER_NAME,
	type PromptRunnerTaskMetadata,
	promptRunnerTaskWorker,
} from "./prompt-runner-task.ts";
export * from "./providers/index.ts";

import { describeImageCached } from "../../media/index.ts";
import { recentErrorsProvider } from "../../providers/recent-errors.ts";
import { generateMediaAction } from "../advanced-capabilities/actions/generateMedia.ts";
// Import advanced capabilities
import {
	advancedActions,
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
import { readAttachmentAction } from "../working-memory/readAttachmentAction.ts";
// Import for local use.
//
// Direct leaf imports — see comment in
// ../advanced-capabilities/index.ts for the Bun.build mis-rewrite that
// requires bypassing barrels here too.
import { channelTopicSearchAction } from "./actions/channel-topic-search.ts";
import { choiceAction } from "./actions/choice.ts";
import { ignoreAction } from "./actions/ignore.ts";
import { noneAction } from "./actions/none.ts";
import { replyAction } from "./actions/reply.ts";
import { CHANNEL_TOPICS_ROUTES } from "./channel-topics-routes.ts";
import { linkExtractionEvaluator } from "./evaluators/link-extraction.ts";
import { actionStateProvider } from "./providers/actionState.ts";
import { actionsProvider } from "./providers/actions.ts";
import { attachmentsProvider } from "./providers/attachments.ts";
import { channelTopicsProvider } from "./providers/channelTopics.ts";
import { characterProvider } from "./providers/character.ts";
import { choiceProvider } from "./providers/choice.ts";
import { contextBenchProvider } from "./providers/contextBench.ts";
import { currentTimeProvider } from "./providers/currentTime.ts";
import { entitiesProvider } from "./providers/entities.ts";
import {
	platformChatContextProvider,
	platformUserContextProvider,
} from "./providers/platformContext.ts";
import { providersProvider } from "./providers/providers.ts";
import { recentMessagesProvider } from "./providers/recentMessages.ts";
import { runtimeModelContextProvider } from "./providers/runtimeModelContext.ts";
import { uiContextProvider } from "./providers/uiContext.ts";
import { userEmotionSignalProvider } from "./providers/userEmotionSignal.ts";
import { worldProvider } from "./providers/world.ts";

// Re-export advanced capability modules
export * from "../advanced-capabilities/actions/index.ts";
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
	pluginAction,
	type SecurityDeps,
} from "../plugin-manager/index.ts";

// ============================================================================
// Structured JSON response interfaces.
// ============================================================================

interface PostCreationJson {
	post?: string;
	thought?: string;
}

const MAX_POST_GENERATION_ATTEMPTS = 3;

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
				// Attachment URLs are caller/agent-supplied — route through the SSRF
				// guard so a crafted URL can't reach internal/metadata endpoints.
				const { response, release } = await fetchWithSsrfGuard({
					url: attachment.url,
					timeoutMs: 30_000,
				});
				try {
					if (!response.ok) {
						throw new Error(`Failed to fetch file: ${attachment.url}`);
					}
					const mediaBuffer = Buffer.from(await response.arrayBuffer());
					const mediaType = attachment.contentType || "image/png";
					return { data: mediaBuffer, mediaType };
				} finally {
					await release();
				}
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

			const resolvedImageDescriptionPrompt = resolveOptimizedPromptForRuntime(
				runtime,
				"media_description",
				imageDescriptionTemplate,
			);
			// Route through the shared content-addressed cache so identical bytes
			// reuse one description across all describe paths.
			const described = await describeImageCached(
				runtime,
				imageUrl,
				resolvedImageDescriptionPrompt,
			);
			if (described) {
				processedAttachment.description = described.description;
				processedAttachment.title = described.title || "Image";
				processedAttachment.text = described.text;
				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						descriptionPreview:
							described.description.substring(0, 100) || undefined,
					},
					"Generated description",
				);
			} else {
				runtime.logger.warn(
					{ src: "basic-capabilities", agentId: runtime.agentId },
					"Image description unavailable",
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
			// Any text/* document (plain, csv, markdown — all on the chat upload
			// allow-list) is readable as text. Previously only text/plain was
			// handled, so csv/markdown fell through to "skipped" (#10714).
			const isText = contentType.startsWith("text/");
			const isPdf = contentType.startsWith("application/pdf");

			if (isText) {
				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						url: attachment.url,
					},
					"Processing text document",
				);

				const textContent = await res.text();
				processedAttachment.text = textContent;
				processedAttachment.title = processedAttachment.title || "Text File";

				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						textPreview:
							processedAttachment.text.substring(0, 100) || undefined,
					},
					"Extracted text content",
				);
			} else if (isPdf) {
				// Extract PDF text so a PDF attachment is readable by the agent
				// instead of being silently skipped (#10714). Dynamic import keeps
				// the heavy `unpdf` dependency off the hot path — it loads only when
				// a PDF is actually processed.
				const { convertPdfToTextFromBuffer } = await import(
					"../documents/utils"
				);
				const pdfBuffer = Buffer.from(await res.arrayBuffer());
				const textContent = await convertPdfToTextFromBuffer(
					pdfBuffer,
					processedAttachment.title ?? undefined,
				);
				processedAttachment.text = textContent;
				processedAttachment.title = processedAttachment.title || "PDF Document";

				runtime.logger.debug(
					{
						src: "basic-capabilities",
						agentId: runtime.agentId,
						textLength: textContent.length,
						textPreview: textContent.substring(0, 100) || undefined,
					},
					"Extracted PDF text content",
				);
			} else {
				runtime.logger.warn(
					{ src: "basic-capabilities", agentId: runtime.agentId, contentType },
					"Skipping unsupported document type",
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

	const alwaysRespondSources = [MESSAGE_SOURCE_CLIENT_CHAT];

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

	const roomType = room.type.toString().toLowerCase() || undefined;
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

	// 5. All other cases: let the LLM decide
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

const postGeneratedHandler = async (
	{ runtime, callback, worldId, userId, roomId, source }: InvokePayload,
	attempt = 1,
) => {
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

	// Compose state with relevant context for post generation
	const state = await runtime.composeState(message, [
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

	const postPrompt = composePromptFromState({
		state,
		template:
			runtime.character.templates?.postCreationTemplate || postCreationTemplate,
	});

	const structuredResponseText = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt: postPrompt,
	});

	const parsedJsonResponse = parseJSONObjectFromText(
		structuredResponseText,
	) as PostCreationJson | null;

	if (!parsedJsonResponse) {
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

	const cleanedText = cleanupPostText(parsedJsonResponse.post ?? "");
	const stateData = state.data;
	const stateDataProviders = stateData.providers;
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
				if (attempt >= MAX_POST_GENERATION_ATTEMPTS) {
					runtime.logger.warn(
						{
							src: "basic-capabilities",
							agentId: runtime.agentId,
							cleanedText,
						},
						"Post generation retry limit reached for repeated content",
					);
					return;
				}
				await postGeneratedHandler(
					{
						runtime,
						callback,
						worldId,
						userId,
						roomId,
						source,
					},
					attempt + 1,
				);
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
		if (attempt >= MAX_POST_GENERATION_ATTEMPTS) {
			runtime.logger.warn(
				{ src: "basic-capabilities", agentId: runtime.agentId, cleanedText },
				"Post generation retry limit reached for moderation refusals",
			);
			return;
		}
		await postGeneratedHandler(
			{
				runtime,
				callback,
				worldId,
				userId,
				roomId,
				source,
			},
			attempt + 1,
		);
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
				thought: parsedJsonResponse.thought ?? "",
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
/**
 * World metadata for a DM channel. The DM sender is granted OWNER of their DM
 * world ONLY when they are a configured canonical owner (#12087 Item 2). Writing
 * `roles[entityId] = OWNER` for EVERY DM sender (the prior behavior) made anyone
 * who could DM the agent the OWNER of their own DM world — and with no canonical
 * owner configured (the default), that grant is honored by `resolveOwnershipRole`,
 * clearing every `minRole: OWNER` gate (SECRETS, SHELL, …) for that sender. The
 * grant now goes through the auditable `recordOwnerGrant` API behind an explicit
 * owner match; a non-owner DM sender gets an empty (non-owner) world.
 */
export function buildDmWorldMetadata(
	runtime: IAgentRuntime,
	entityId: string,
): Record<string, JsonValue> {
	if (getConfiguredOwnerEntityIds(runtime).includes(entityId)) {
		const grant: RolesWorldMetadata = {};
		recordOwnerGrant(grant, entityId);
		return {
			ownership: { ownerId: entityId },
			roles: grant.roles ?? {},
			roleSources: grant.roleSources ?? {},
			settings: {}, // Initialize empty settings for setup
		};
	}
	return { settings: {} };
}

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
			? buildDmWorldMetadata(runtime, entityId)
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

	const controlTransport = runtime.getService<IControlTransportService>(
		ServiceType.CONTROL_TRANSPORT,
	);

	if (!controlTransport) {
		runtime.logger.error(
			{ src: "basic-capabilities", agentId: runtime.agentId },
			"No control transport service found to send control message",
		);
		return;
	}

	await controlTransport.sendMessage({
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
};

// ============================================================================
// Events Configuration
// ============================================================================

const connectorMessageReceivedEvents = Object.fromEntries(
	CONNECTOR_MESSAGE_RECEIVED_EVENT_TYPES.map((eventType) => [
		eventType,
		[
			async (payload: EventPayload) => {
				await bridgeConnectorMessageReceivedToStreams(eventType, payload);
			},
		],
	]),
) as PluginEvents;

const events: PluginEvents = {
	...connectorMessageReceivedEvents,

	// Bridge every connector's inbound message onto the AgentEventService
	// `message` stream so the home activity rail shows the agent fielding
	// messages (Discord/Telegram/etc.), not just orchestrator tasks (#9449).
	[EventType.MESSAGE_RECEIVED]: [
		async (payload: MessagePayload) => {
			await bridgeMessageReceivedToStreams(payload);
		},
	],
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

			const channelType = payloadMetadata.type;
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
			// Bridge to the AgentEventService action/lifecycle streams so the WS
			// `agent_event` channel carries real per-turn phase data (#8813 AC#3).
			bridgeActionStartedToStreams(payload);
		},
		async (payload: ActionEventPayload) => {
			// Only notify for client_chat messages
			const payloadContent = payload.content;
			if (payloadContent?.source === MESSAGE_SOURCE_CLIENT_CHAT) {
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
			const contentActions = content.actions;
			const actionName = contentActions?.[0] ?? "unknown";

			await payload.runtime.createLogs([
				{
					entityId: payload.runtime.agentId,
					roomId: payload.roomId,
					type: "action_event",
					body: {
						runId: (content.runId as string | undefined) ?? "",
						actionId: (content.actionId as string | undefined) ?? "",
						actionName: actionName,
						roomId: payload.roomId,
						messageId: payload.messageId,
						timestamp: Date.now(),
						planStep: (content.planStep as string | undefined) ?? "",
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
			// Bridge to the AgentEventService action/lifecycle streams (#8813 AC#3).
			bridgeActionCompletedToStreams(payload);
		},
		async (payload: ActionEventPayload) => {
			// Only notify for client_chat messages
			const payloadContent = payload.content;
			if (payloadContent?.source === MESSAGE_SOURCE_CLIENT_CHAT) {
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

	[EventType.RUN_STARTED]: [
		async (payload: RunEventPayload) => {
			// Bridge to the AgentEventService lifecycle stream (#8813 AC#3).
			bridgeRunStartedToStreams(payload);
		},
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
			// Bridge to the AgentEventService lifecycle stream (#8813 AC#3).
			bridgeRunEndedToStreams(payload);
		},
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

	[EventType.EVALUATOR_STARTED]: [
		async (payload: EvaluatorEventPayload) => {
			// Bridge to the AgentEventService evaluator stream (#8813 AC#3).
			bridgeEvaluatorStartedToStreams(payload);
		},
	],

	[EventType.EVALUATOR_COMPLETED]: [
		async (payload: EvaluatorEventPayload) => {
			// Bridge to the AgentEventService evaluator stream (#8813 AC#3).
			bridgeEvaluatorCompletedToStreams(payload);
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
	actionsProvider,
	actionStateProvider,
	attachmentsProvider,
	channelTopicsProvider,
	characterProvider,
	choiceProvider,
	contextBenchProvider,
	currentTimeProvider,
	entitiesProvider,
	platformChatContextProvider,
	platformUserContextProvider,
	providersProvider,
	recentErrorsProvider,
	recentMessagesProvider,
	runtimeModelContextProvider,
	uiContextProvider,
	userEmotionSignalProvider,
	worldProvider,
];

/**
 * Basic actions - fundamental response actions
 */
export const basicActions = [
	withCanonicalActionDocs(choiceAction),
	withCanonicalActionDocs(generateMediaAction),
	withCanonicalActionDocs(readAttachmentAction),
	withCanonicalActionDocs(replyAction),
	withCanonicalActionDocs(ignoreAction),
	withCanonicalActionDocs(noneAction),
	withCanonicalActionDocs(channelTopicSearchAction),
];

/**
 * Basic evaluators - inbound auto-capture side-effects.
 *
 * - `linkExtractionEvaluator` runs when the inbound message text contains an
 *   http(s) URL; it extracts each URL, optionally fetches a title + body
 *   summary via TEXT_SMALL, and writes the result into the `links` memory
 *   table.
 *
 * (Inbound image attachments are described during message processing via the
 * shared image-description cache — `MessageService.processAttachments` — so no
 * separate evaluator re-runs the vision model post-response.)
 *
 * Transparent — never modifies the response or consumes a planner slot. Wraps
 * its own model calls in try/catch and logs on failure.
 */
export const basicEvaluators: RegisteredEvaluator[] = [linkExtractionEvaluator];

/**
 * Basic services - essential infrastructure services
 */
export const basicServices: ServiceClass[] = [
	TaskService,
	EmbeddingGenerationService,
	EvaluatorService,
	// Loads optimized prompts for action_planner / media_description / etc.
	// from the on-disk store (<stateDir>/optimized-prompts/<task>). Cheap
	// in-memory cache; registering it on every runtime so the planner-loop
	// can pick up artifacts produced by `bun run train -- --backend native`.
	OptimizedPromptService,
	// Per-channel topic LRU. Records Stage-1-extracted topics per room and
	// surfaces them back into routing via the CHANNEL_TOPICS provider.
	ChannelTopicsService,
	SensitiveRequestDispatchRegistryService,
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
 * - Advanced/Extended: Additional features (choice, mute/follow room, roles, settings)
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

/**
 * Explicit (constructor-level) capability toggles a runtime already knows,
 * before the character-settings fallback is applied. Every field is a resolved
 * boolean or `undefined` ("not specified") — `undefined` defers to the matching
 * character setting; a concrete boolean overrides it.
 */
export interface ExplicitCapabilityOptions {
	disableBasic?: boolean;
	enableExtended?: boolean;
	advancedCapabilities?: boolean;
	skipCharacterProvider?: boolean;
	enableAutonomy?: boolean;
	enableTrust?: boolean;
	enableSecretsManager?: boolean;
	enablePluginManager?: boolean;
}

/**
 * The subset of character settings that toggle capabilities. Each is the
 * character-file fallback for the matching explicit option; string `"true"` and
 * boolean `true` both count as on, everything else off. Kept structural (no
 * import of the full `CharacterSettings`) so this feature module stays free of a
 * back-edge to the agent-type surface.
 */
export interface CapabilitySettingFlags {
	DISABLE_BASIC_CAPABILITIES?: boolean | string;
	ENABLE_EXTENDED_CAPABILITIES?: boolean | string;
	ADVANCED_CAPABILITIES?: boolean | string;
	ENABLE_AUTONOMY?: boolean | string;
	ENABLE_TRUST?: boolean | string;
	ENABLE_SECRETS_MANAGER?: boolean | string;
	ENABLE_PLUGIN_MANAGER?: boolean | string;
}

const isSettingEnabled = (value: boolean | string | undefined): boolean =>
	value === true || value === "true";

/**
 * Resolve the complete capability configuration a runtime should build its
 * basic-capabilities plugin from. Explicit constructor options win; where an
 * option is unspecified the matching character setting decides.
 *
 * This is the single source of truth for capability resolution: the runtime
 * calls it once at construction and hands the resulting config to
 * {@link createBasicCapabilitiesPlugin}. Registration then carries no knowledge
 * of capability flags — the declaring plugin already reflects them — which is
 * why `registerPlugin` needs no name-keyed special case.
 */
export function resolveCapabilityConfig(
	options: ExplicitCapabilityOptions,
	settings: CapabilitySettingFlags | undefined,
): CapabilityConfig {
	return {
		disableBasic:
			options.disableBasic ??
			isSettingEnabled(settings?.DISABLE_BASIC_CAPABILITIES),
		enableExtended:
			options.enableExtended ??
			options.advancedCapabilities ??
			(isSettingEnabled(settings?.ENABLE_EXTENDED_CAPABILITIES) ||
				isSettingEnabled(settings?.ADVANCED_CAPABILITIES)),
		skipCharacterProvider: options.skipCharacterProvider ?? false,
		enableAutonomy:
			options.enableAutonomy ?? isSettingEnabled(settings?.ENABLE_AUTONOMY),
		enableTrust:
			options.enableTrust ?? isSettingEnabled(settings?.ENABLE_TRUST),
		enableSecretsManager:
			options.enableSecretsManager ??
			isSettingEnabled(settings?.ENABLE_SECRETS_MANAGER),
		enablePluginManager:
			options.enablePluginManager ??
			isSettingEnabled(settings?.ENABLE_PLUGIN_MANAGER),
	};
}

// Autonomy capabilities - opt-in
// Provides autonomous operation with continuous agent thinking loop
const autonomyCapabilities = {
	providers: [adminChatProvider, autonomyStatusProvider],
	actions: [
		withCanonicalActionDocs(enableAutonomousModeAction),
		withCanonicalActionDocs(disableAutonomousModeAction),
		withCanonicalActionDocs(escalateAction),
	],
	services: [AutonomyService] as ServiceClass[],
	routes: autonomyRoutes,
};

export { autonomyCapabilities };

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
		description: "Agent basic capabilities with core actions",
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
		],
		services: [
			...(config.disableBasic ? [] : basicServices),
			...(useAdvanced ? advancedServices : []),
			...(config.enableAutonomy ? autonomyCapabilities.services : []),
			...(config.enableTrust ? trustCapability.services : []),
			...(config.enableSecretsManager ? secretsCapability.services : []),
			...(config.enablePluginManager ? pluginManagerCapability.services : []),
		],
		routes: [
			...TURN_CONTROL_ROUTES,
			...CHANNEL_TOPICS_ROUTES,
			...(config.enableAutonomy ? autonomyCapabilities.routes : []),
		],
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
		async dispose(runtime) {
			// Stop all services that may have been registered based on config.
			// Optional chaining skips services that were not started.
			await runtime.getService(TaskService.serviceType)?.stop();
			await runtime.getService(EmbeddingGenerationService.serviceType)?.stop();
			await runtime.getService(EvaluatorService.serviceType)?.stop();
			await runtime.getService(OptimizedPromptService.serviceType)?.stop();
			await runtime.getService(ChannelTopicsService.serviceType)?.stop();
			await runtime
				.getService(SensitiveRequestDispatchRegistryService.serviceType)
				?.stop();
			if (config.enableAutonomy) {
				await runtime.getService(AutonomyService.serviceType)?.stop();
			}
		},
	};
}

export default basicCapabilities;

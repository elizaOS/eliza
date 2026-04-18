import { v4 } from "uuid";
import { parseActionParams } from "../actions";
import { createUniqueUuid } from "../entities";
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "../features/advanced-capabilities/evaluators/task-completion";
import { logger } from "../logger";
import {
	imageDescriptionTemplate,
	messageHandlerTemplate,
	multiStepDecisionTemplate,
	multiStepSummaryTemplate,
	postActionDecisionTemplate,
	shouldRespondTemplate,
} from "../prompts";
import { isExplicitSelfModificationRequest } from "../should-respond";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptService,
} from "./optimized-prompt";
import { resolveOptimizedPrompt } from "./optimized-prompt-resolver";
import {
	getModelStreamChunkDeliveryDepth,
	runWithStreamingContext,
} from "../streaming-context";
import {
	runWithTrajectoryContext,
	setTrajectoryPurpose,
} from "../trajectory-context";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	StreamChunkCallback,
} from "../types/components";
import type { Room } from "../types/environment";
import type { RunEventPayload } from "../types/events";
import { EventType } from "../types/events";
import type { Memory } from "../types/memory";
import type {
	ContextRoutedResponseDecision,
	DualPressureScores,
	IMessageService,
	MessageProcessingOptions,
	MessageProcessingResult,
	ShouldRespondModelType,
} from "../types/message-service";
import type {
	GenerateTextAttachment,
	TextGenerationModelType,
	TextToSpeechParams,
} from "../types/model";
import { ModelType } from "../types/model";
import {
	incomingPipelineHookContext,
	modelStreamChunkPipelineHookContext,
	outgoingPipelineHookContext,
	parallelWithShouldRespondPipelineHookContext,
	preShouldRespondPipelineHookContext,
} from "../types/pipeline-hooks";
import type { Content, Media, MentionContext, UUID } from "../types/primitives";
import { asUUID, ChannelType, ContentType } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type {
	ProviderCacheEntry,
	State,
	StateValue,
	StructuredOutputFailure,
} from "../types/state";
import {
	composePromptFromState,
	getLocalServerUrl,
	parseBooleanFromText,
	parseJSONObjectFromText,
	parseKeyValueXml,
	truncateToCompleteSentence,
} from "../utils";
import {
	AVAILABLE_CONTEXTS_STATE_KEY,
	attachAvailableContexts,
	CONTEXT_ROUTING_STATE_KEY,
	type ContextRoutingDecision,
	mergeContextRouting,
	parseContextRoutingMetadata,
	setContextRoutingMetadata,
} from "../utils/context-routing";
import {
	createStreamingContext,
	MarkableExtractor,
	ResponseStreamExtractor,
} from "../utils/streaming";
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";

/**
 * Reserved XML response keys that are NOT action names.
 * Used when scanning parsedXml for standalone action param blocks.
 */
export const RESERVED_XML_KEYS = new Set([
	"actions",
	"thought",
	"text",
	"simple",
	"providers",
]);

const PLANNER_CONTROL_ACTIONS = new Set(
	["REPLY", "RESPOND", "IGNORE", "STOP"].map(normalizeActionIdentifier),
);

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

	return names.some((name) => {
		const candidate = name?.trim();
		if (!candidate) {
			return false;
		}

		const pattern = new RegExp(
			`(^|[^\\p{L}\\p{N}])${escapeRegex(candidate)}(?=$|[^\\p{L}\\p{N}])`,
			"iu",
		);
		return pattern.test(text);
	});
}

function textContainsUserTag(text: string | undefined): boolean {
	if (!text) {
		return false;
	}

	return /<@!?[^>]+>|@\w+/u.test(text);
}

const DEFAULT_DUAL_PRESSURE_THRESHOLD = 20;
const ALLOWED_CLASSIFIER_ACTIONS = new Set([
	"REPLY",
	"RESPOND",
	"IGNORE",
	"STOP",
]);

function resolveDualPressureThreshold(runtime: IAgentRuntime): number {
	const raw = runtime.getSetting("DUAL_PRESSURE_THRESHOLD");
	const value = Number.parseInt(String(raw ?? ""), 10);
	if (Number.isFinite(value) && value >= 1 && value <= 100) {
		return value;
	}
	return DEFAULT_DUAL_PRESSURE_THRESHOLD;
}

function parseOptionalPressureInt(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) {
		return value >= 0 && value <= 100 ? value : null;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
			? parsed
			: null;
	}
	return null;
}

function applyDualPressureToClassifierAction(
	runtime: IAgentRuntime,
	responseObject: Record<string, unknown> | null,
	rawAction: string,
): { pressure: DualPressureScores | null; finalActionUpper: string } {
	const threshold = resolveDualPressureThreshold(runtime);
	const actionUpper = rawAction.trim().toUpperCase();
	const speakRaw = responseObject?.speak_up ?? responseObject?.speakUp;
	const holdRaw = responseObject?.hold_back ?? responseObject?.holdBack;
	const speakUp = parseOptionalPressureInt(speakRaw);
	const holdBack = parseOptionalPressureInt(holdRaw);

	if (speakUp === null || holdBack === null) {
		runtime.logger.warn(
			{
				src: "service:message",
				action: actionUpper,
				speakUp: speakRaw,
				holdBack: holdRaw,
			},
			"Classifier response missing valid dual-pressure scores; treating as IGNORE",
		);
		return { pressure: null, finalActionUpper: "IGNORE" };
	}

	const net = speakUp - holdBack;
	const pressure: DualPressureScores = { speakUp, holdBack, net };

	if (actionUpper === "STOP") {
		return { pressure, finalActionUpper: "STOP" };
	}

	const isEngage = actionUpper === "REPLY" || actionUpper === "RESPOND";
	if (net <= -threshold && isEngage) {
		runtime.logger.warn(
			{
				src: "service:message",
				net,
				threshold,
				originalAction: actionUpper,
				speakUp,
				holdBack,
			},
			"Dual pressure: net below threshold but model chose engage; clamping to IGNORE",
		);
		return { pressure, finalActionUpper: "IGNORE" };
	}

	if (net >= threshold && actionUpper === "IGNORE") {
		runtime.logger.warn(
			{
				src: "service:message",
				net,
				threshold,
				speakUp,
				holdBack,
			},
			"Dual pressure: high net but IGNORE chosen; allowing model decision",
		);
	}

	return { pressure, finalActionUpper: actionUpper };
}

/**
 * Extract action params from standalone XML blocks in a parsedXml object.
 *
 * When the LLM outputs `<actions>REPLY,START_CODING_TASK</actions>` alongside
 * `<START_CODING_TASK><repo>...</repo></START_CODING_TASK>`, the XML parser
 * puts the action block as a top-level key on parsedXml. This function finds
 * those keys and assembles them into the legacy flat params format that
 * `parseActionParams` consumes.
 *
 * Returns the assembled params string, or empty string if none found.
 */
export function extractStandaloneActionParams(
	actionNames: string[],
	parsedXml: Record<string, unknown>,
): string {
	const fragments: string[] = [];
	for (const actionName of actionNames) {
		const upperName = actionName.toUpperCase();
		const matchingKey = Object.keys(parsedXml).find(
			(k) => k.toUpperCase() === upperName,
		);
		if (
			matchingKey &&
			!RESERVED_XML_KEYS.has(matchingKey.toLowerCase()) &&
			typeof parsedXml[matchingKey] === "string" &&
			(parsedXml[matchingKey] as string).includes("<")
		) {
			fragments.push(`<${upperName}>${parsedXml[matchingKey]}</${upperName}>`);
		}
	}
	return fragments.join("\n");
}

export function extractPlannerActionNames(
	parsedXml: Record<string, unknown>,
): string[] {
	return (() => {
		if (typeof parsedXml.actions === "string") {
			const actionsXml = parsedXml.actions;
			if (/<action\b[^>]*>/i.test(actionsXml)) {
				const actionEntries: Array<{
					name: string;
					paramsXml?: string;
				}> = [];
				for (const match of actionsXml.matchAll(
					/<action\b[^>]*>([\s\S]*?)<\/action>/gi,
				)) {
					const inner = match[1];
					const nameMatch = inner.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
					const paramsMatch = inner.match(
						/<params\b[^>]*>([\s\S]*?)<\/params>/i,
					);
					const name = unwrapPlannerIdentifier(
						nameMatch ? nameMatch[1] : match[0],
					);
					const paramsXml = paramsMatch ? paramsMatch[1].trim() : undefined;
					if (name) actionEntries.push({ name, paramsXml });
				}

				if (actionEntries.length > 0) {
					const inlineParamsXml = actionEntries
						.filter((entry) => entry.paramsXml)
						.map(
							(entry) =>
								`<${entry.name.toUpperCase()}>${entry.paramsXml}</${entry.name.toUpperCase()}>`,
						)
						.join("\n");
					if (
						inlineParamsXml &&
						(!parsedXml.params || parsedXml.params === "")
					) {
						parsedXml.params = inlineParamsXml;
					}

					return actionEntries.map((entry) => entry.name);
				}
			}

			const commaSplitActions = actionsXml
				.split(",")
				.map((action) => unwrapPlannerIdentifier(String(action)))
				.filter((action) => action.length > 0);

			if (!parsedXml.params || parsedXml.params === "") {
				const assembled = extractStandaloneActionParams(
					commaSplitActions,
					parsedXml,
				);
				if (assembled) {
					parsedXml.params = assembled;
				}
			}

			return commaSplitActions;
		}
		if (Array.isArray(parsedXml.actions)) {
			return parsedXml.actions
				.map((action) => unwrapPlannerIdentifier(String(action)))
				.filter((action) => action.length > 0);
		}
		return [];
	})();
}

function normalizePlannerActions(
	parsedXml: Record<string, unknown>,
	runtime: IAgentRuntime,
): string[] {
	const normalizedActions = extractPlannerActionNames(parsedXml);

	const finalActions =
		!runtime.isActionPlanningEnabled() && normalizedActions.length > 1
			? [normalizedActions[0]]
			: normalizedActions;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const validActions = finalActions.flatMap((actionName) => {
		const normalized = normalizeActionIdentifier(actionName);
		if (!normalized) {
			return [];
		}

		if (PLANNER_CONTROL_ACTIONS.has(normalized)) {
			return [actionName];
		}

		const resolvedAction = resolveRuntimeAction(actionLookup, actionName);
		if (resolvedAction) {
			return [resolvedAction.name];
		}

		const aliasedActionName = PLANNER_ACTION_ALIASES.get(normalized);
		if (aliasedActionName) {
			const resolvedAlias = resolveRuntimeAction(
				actionLookup,
				aliasedActionName,
			);
			if (resolvedAlias) {
				runtime.logger.info(
					{
						src: "service:message",
						actionName,
						aliasedActionName: resolvedAlias.name,
					},
					"Repaired planner action alias",
				);
				return [resolvedAlias.name];
			}
		}

		runtime.logger.warn(
			{
				src: "service:message",
				actionName,
			},
			"Dropping unknown planner action",
		);
		return [];
	});

	if (validActions.length > 0) {
		return validActions;
	}

	const replyText =
		typeof parsedXml.text === "string" ? parsedXml.text.trim() : "";
	return replyText.length > 0 ? ["REPLY"] : ["IGNORE"];
}

function normalizePlannerProviders(
	parsedXml: Record<string, unknown>,
	runtime?: IAgentRuntime,
): string[] {
	const rawProviders = parsedXml.providers;
	const providerNames = (() => {
		if (typeof rawProviders === "string") {
			const trimmedProviders = rawProviders.trim();
			if (
				(trimmedProviders.startsWith("[") && trimmedProviders.endsWith("]")) ||
				(trimmedProviders.startsWith("{") && trimmedProviders.endsWith("}"))
			) {
				try {
					const parsedJson = JSON.parse(trimmedProviders) as unknown;
					if (Array.isArray(parsedJson)) {
						return parsedJson
							.map((providerName) => String(providerName).trim())
							.filter((providerName) => providerName.length > 0);
					}
					if (
						typeof parsedJson === "object" &&
						parsedJson !== null &&
						Array.isArray(
							(parsedJson as { providers?: unknown }).providers,
						)
					) {
						return (
							(parsedJson as { providers: unknown[] }).providers
								.map((providerName) => String(providerName).trim())
								.filter((providerName) => providerName.length > 0)
						);
					}
				} catch {
					// Fall through to XML/comma parsing below.
				}
			}

			if (
				rawProviders.includes("<provider>") ||
				rawProviders.includes("<provider ")
			) {
				const providers = Array.from(
					rawProviders.matchAll(/<provider>([\s\S]*?)<\/provider>/g),
				)
					.map((match) => match[1]?.trim() ?? "")
					.filter((providerName) => providerName.length > 0);
				if (providers.length > 0) {
					return providers;
				}
			}

			return rawProviders
				.split(/[\n,;]/)
				.map((providerName) =>
					providerName.replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ""),
				)
				.map((providerName) => providerName.trim())
				.filter((providerName) => providerName.length > 0);
		}

		if (Array.isArray(rawProviders)) {
			return rawProviders
				.map((providerName) => String(providerName).trim())
				.filter((providerName) => providerName.length > 0);
		}

		return [];
	})();

	if (!runtime) {
		return providerNames;
	}

	const providerLookup = new Map<string, string>();
	for (const provider of runtime.providers ?? []) {
		const normalized = normalizeActionIdentifier(provider.name);
		if (!normalized || providerLookup.has(normalized)) {
			continue;
		}
		providerLookup.set(normalized, provider.name);
	}
	const normalizedProviders = providerNames
		.map((providerName) => {
			const normalizedProviderName = normalizeActionIdentifier(providerName);
			const canonicalProvider =
				providerLookup.get(normalizedProviderName) ??
				(() => {
					const aliasedProvider =
						PLANNER_PROVIDER_ALIASES.get(normalizedProviderName);
					if (!aliasedProvider) {
						return undefined;
					}
					return providerLookup.get(normalizeActionIdentifier(aliasedProvider));
				})();
			if (canonicalProvider) {
				return canonicalProvider;
			}
			runtime.logger.warn(
				{
					src: "service:message",
					providerName,
				},
				"Dropping unknown planner provider",
			);
			return "";
		})
		.filter((providerName) => providerName.length > 0);

	if (normalizedProviders.length === 0) {
		return normalizedProviders;
	}

	const providerDefinitions = new Map(
		(runtime.providers ?? []).map((provider) => [
			normalizeActionIdentifier(provider.name),
			provider,
		]),
	);
	const expandedProviders = [...normalizedProviders];
	const seenProviders = new Set(
		expandedProviders.map((providerName) =>
			normalizeActionIdentifier(providerName),
		),
	);

	for (let index = 0; index < expandedProviders.length; index += 1) {
		const providerName = expandedProviders[index];
		const providerDefinition = providerDefinitions.get(
			normalizeActionIdentifier(providerName),
		);
		const companionProviders = providerDefinition?.companionProviders ?? [];
		for (const companionProvider of companionProviders) {
			const canonicalCompanion = providerLookup.get(
				normalizeActionIdentifier(companionProvider),
			);
			if (!canonicalCompanion) {
				runtime.logger.warn(
					{
						src: "service:message",
						providerName,
						companionProvider,
					},
					"Dropping unknown companion provider",
				);
				continue;
			}
			const normalizedCompanion =
				normalizeActionIdentifier(canonicalCompanion);
			if (seenProviders.has(normalizedCompanion)) {
				continue;
			}
			seenProviders.add(normalizedCompanion);
			expandedProviders.push(canonicalCompanion);
		}
	}

	return expandedProviders;
}

const CORE_RESPONSE_STATE_PROVIDERS = [
	"ENTITIES",
	"CHARACTER",
	"RECENT_MESSAGES",
	"ACTIONS",
	"PROVIDERS",
];

const STRUCTURED_RESPONSE_STATE_PROVIDERS = ["ACTIONS", "PROVIDERS"];
const FOCUSED_PROVIDER_REPLY_STATE_PROVIDERS = ["CHARACTER", "RECENT_MESSAGES"];

function composeResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		CORE_RESPONSE_STATE_PROVIDERS,
		true,
		skipCache,
	);
}

function composeStructuredResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		STRUCTURED_RESPONSE_STATE_PROVIDERS,
		false,
		skipCache,
	);
}

function composeProviderGroundedResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	providers: string[],
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		[...CORE_RESPONSE_STATE_PROVIDERS, ...providers],
		false,
		skipCache,
	);
}

function composeFocusedProviderReplyState(
	runtime: IAgentRuntime,
	message: Memory,
	providers: string[],
	skipCache = false,
): Promise<State> {
	return runtime.composeState(
		message,
		[...FOCUSED_PROVIDER_REPLY_STATE_PROVIDERS, ...providers],
		true,
		skipCache,
	);
}

/**
 * Escape Handlebars syntax in a string to prevent template injection.
 *
 * WHY: When embedding LLM-generated text into continuation prompts, the text
 * goes through Handlebars.compile(). If the LLM output contains {{variable}},
 * Handlebars will try to substitute it with state values, corrupting the prompt.
 *
 * This function escapes {{ to \\{{ so Handlebars outputs literal {{.
 *
 * @param text - Text that may contain Handlebars-like syntax
 * @returns Text with {{ escaped to prevent interpretation
 */
function escapeHandlebars(text: string): string {
	// Single-pass replacement to avoid double-escaping triple braces.
	return text.replace(/\{\{\{|\{\{/g, (match) => `\\${match}`);
}

/**
 * Image description response from the model
 */
interface ImageDescriptionResponse {
	description: string;
	title?: string;
}

type MediaWithInlineData = Media & {
	_data?: unknown;
	_mimeType?: unknown;
};

function sanitizeAttachmentsForStorage(
	attachments: Media[] | undefined,
): Media[] | undefined {
	if (!attachments?.length) {
		return attachments;
	}

	return attachments.map((attachment) => {
		const {
			_data: _discardData,
			_mimeType: _discardMimeType,
			...rest
		} = attachment as MediaWithInlineData;
		return rest;
	});
}

function resolvePromptAttachments(
	attachments: Media[] | undefined,
): GenerateTextAttachment[] | undefined {
	if (!attachments?.length) {
		return undefined;
	}

	const resolved = attachments.flatMap((attachment) => {
		const withInlineData = attachment as MediaWithInlineData;
		if (
			typeof withInlineData._data === "string" &&
			withInlineData._data.trim() &&
			typeof withInlineData._mimeType === "string" &&
			withInlineData._mimeType.trim()
		) {
			return [
				{
					data: withInlineData._data,
					mediaType: withInlineData._mimeType,
					filename: attachment.title,
				},
			];
		}

		const dataUrlMatch = attachment.url.match(/^data:([^;,]+);base64,(.+)$/i);
		if (dataUrlMatch) {
			return [
				{
					data: dataUrlMatch[2],
					mediaType: dataUrlMatch[1],
					filename: attachment.title,
				},
			];
		}

		return [];
	});

	return resolved.length > 0 ? resolved : undefined;
}

/**
 * Resolved message options with defaults applied.
 * Required numeric options + optional streaming callback.
 */
type ResolvedMessageOptions = {
	maxRetries: number;
	timeoutDuration: number;
	useMultiStep: boolean;
	maxMultiStepIterations: number;
	continueAfterActions: boolean;
	keepExistingResponses: boolean;
	onStreamChunk?: StreamChunkCallback;
	shouldRespondModel: ShouldRespondModelType;
};

function normalizeShouldRespondModelType(
	value: unknown,
): ShouldRespondModelType {
	if (typeof value !== "string") {
		return "response-handler";
	}

	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "nano":
		case "text_nano":
			return "nano";
		case "small":
		case "text_small":
			return "small";
		case "large":
		case "text_large":
			return "large";
		case "mega":
		case "text_mega":
			return "mega";
		case "response-handler":
		case "response_handler":
		case "responsehandler":
			return "response-handler";
		case "response_handler_model":
			return "response-handler";
		default:
			return "response-handler";
	}
}

function resolveShouldRespondModelType(
	model: ShouldRespondModelType,
): TextGenerationModelType {
	switch (normalizeShouldRespondModelType(model)) {
		case "nano":
			return ModelType.TEXT_NANO;
		case "small":
			return ModelType.TEXT_SMALL;
		case "large":
			return ModelType.TEXT_LARGE;
		case "mega":
			return ModelType.TEXT_MEGA;
		default:
			return ModelType.RESPONSE_HANDLER;
	}
}

/**
 * Multi-step workflow action result with action name tracking
 */
interface MultiStepActionResult extends ActionResult {
	data: { actionName: string };
}

/**
 * Multi-step workflow state - uses standard State since StateData.actionResults
 * already supports ActionResult[] properly
 */
type MultiStepState = State;

/**
 * Strategy mode for response generation
 */
type StrategyMode = "simple" | "actions" | "none";

/**
 * Strategy result from core processing
 */
interface StrategyResult {
	responseContent: Content | null;
	responseMessages: Memory[];
	state: State;
	mode: StrategyMode;
}

/**
 * Tracks the latest response ID per agent+room to handle message superseding
 */
const latestResponseIds = new Map<string, Map<string, string>>();

function clearLatestResponseId(
	agentId: UUID,
	roomId: UUID,
	responseId: UUID,
): void {
	const agentMap = latestResponseIds.get(agentId);
	if (!agentMap) {
		return;
	}

	if (agentMap.get(roomId) !== responseId) {
		return;
	}

	agentMap.delete(roomId);
	if (agentMap.size === 0) {
		latestResponseIds.delete(agentId);
	}
}

export function isSimpleReplyResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		responseContent.actions[0].toUpperCase() === "REPLY"
	);
}

function isStopResponse(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return !!(
		responseContent?.actions &&
		responseContent.actions.length === 1 &&
		typeof responseContent.actions[0] === "string" &&
		responseContent.actions[0].toUpperCase() === "STOP"
	);
}

function normalizeActionIdentifier(actionName: string): string {
	return unwrapPlannerIdentifier(actionName).toUpperCase().replace(/_/g, "");
}

function unwrapPlannerIdentifier(value: string): string {
	const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) {
		return "";
	}

	const nameMatch = trimmed.match(/^<name\b[^>]*>([\s\S]*?)<\/name>$/i);
	if (nameMatch) {
		return nameMatch[1].trim();
	}

	const actionMatch = trimmed.match(/^<action\b[^>]*>([\s\S]*?)<\/action>$/i);
	if (!actionMatch) {
		return trimmed;
	}

	const inner = actionMatch[1].trim();
	if (!inner) {
		return "";
	}

	const nestedNameMatch = inner.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
	if (nestedNameMatch) {
		return nestedNameMatch[1].trim();
	}

	return /<[A-Za-z][^>]*>/.test(inner) ? trimmed : inner;
}

const PLANNER_ACTION_ALIASES = new Map(
	[
		["BULK_RESCHEDULE_MEETINGS", "PROPOSE_MEETING_TIMES"],
		["RESCHEDULE_MEETINGS", "CALENDAR_ACTION"],
		["CREATE_RECURRING_EVENT", "CALENDAR_ACTION"],
		["SCHEDULE_RECURRING_MEETING", "CALENDAR_ACTION"],
		["CAPTURE_TRAVEL_PREFERENCES", "UPDATE_OWNER_PROFILE"],
		["CAPTURE_BOOKING_PREFERENCES", "UPDATE_OWNER_PROFILE"],
		["GET_PENDING_ASSETS", "INBOX"],
		["GET_PENDING_ITEMS", "INBOX"],
		["PROPOSE_GROUP_CHAT_HANDOFF", "INBOX"],
		["SET_MULTI_DEVICE_MEETING_REMINDER", "PUBLISH_DEVICE_INTENT"],
		["HANDLE_CANCELLATION_FEE", "PUBLISH_DEVICE_INTENT"],
		["GET_ID_STATUS", "PUBLISH_DEVICE_INTENT"],
		["REQUEST_UPLOAD", "LIFEOPS_COMPUTER_USE"],
	].map(([from, to]) => [
		normalizeActionIdentifier(from),
		normalizeActionIdentifier(to),
	]),
);

const PLANNER_PROVIDER_ALIASES = new Map(
	[
		["DOCUMENT_LOOKUP", "ATTACHMENTS"],
		["INBOX_TRIAGE", "inboxTriage"],
	].map(([from, to]) => [
		normalizeActionIdentifier(from),
		to,
	]),
);

const PROVIDER_FOLLOWUP_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE"].map(normalizeActionIdentifier),
);

const ACTION_REPAIR_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE", "IGNORE"].map(normalizeActionIdentifier),
);

function shouldAttemptCanonicalActionRepair(
	rawPlannerActions: string[],
	normalizedActions: string[],
): boolean {
	const hasUnknownOperationalAction = rawPlannerActions.some((actionName) => {
		const normalized = normalizeActionIdentifier(actionName);
		return (
			normalized.length > 0 &&
			!ACTION_REPAIR_PASSIVE_ACTIONS.has(normalized) &&
			!PLANNER_CONTROL_ACTIONS.has(normalized)
		);
	});

	if (!hasUnknownOperationalAction) {
		return false;
	}

	return (
		normalizedActions.length === 0 ||
		normalizedActions.every((actionName) =>
			ACTION_REPAIR_PASSIVE_ACTIONS.has(
				normalizeActionIdentifier(actionName),
			),
		)
	);
}

function buildCanonicalActionRepairPrompt(args: {
	userText: string;
	rawPlannerActions: string[];
	rawPlannerProviders: string[];
	plannerReplyText: string;
	availableActionNames: string[];
}): string {
	const plannerReplyText =
		args.plannerReplyText.trim().length > 0
			? args.plannerReplyText.trim()
			: "(empty)";

	return [
		"You are repairing an action-planner output that used a non-canonical action name.",
		"Choose ONLY from the available runtime actions below.",
		"If the user explicitly asked for an operational artifact or workflow, select the responsible action instead of replying inline.",
		"If the subject is already present, do not ask a clarifying question just because the original planner used a generic lookup verb.",
		"Map generic planner labels like LOOKUP, SEARCH, FETCH, GET, RETRIEVE, BRIEF, or BACKGROUND to the best canonical runtime action.",
		'Return ONLY XML with top-level fields from this schema: <response><actions>...</actions><providers>...</providers><params>...</params></response>.',
		"Do not include <text> unless there is truly no matching runtime action.",
		"",
		`user_message:\n${args.userText}`,
		"",
		`planner_actions_raw:\n${JSON.stringify(args.rawPlannerActions, null, 2)}`,
		"",
		`planner_providers_raw:\n${JSON.stringify(args.rawPlannerProviders, null, 2)}`,
		"",
		`planner_reply_text:\n${plannerReplyText}`,
		"",
		`available_runtime_actions:\n${args.availableActionNames.join(", ")}`,
		"",
		"Example:",
		'user_message: "Pull up a dossier on Satya Nadella."',
		'planner_actions_raw: ["LOOKUP"]',
		'output: <response><actions><action>DOSSIER</action></actions><params><DOSSIER><subject>Satya Nadella</subject></DOSSIER></params></response>',
	].join("\n");
}

async function repairCanonicalPlannerActions(args: {
	runtime: IAgentRuntime;
	message: Memory;
	rawPlannerActions: string[];
	rawPlannerProviders: string[];
	plannerReplyText: string;
}): Promise<Record<string, unknown> | null> {
	const availableActionNames = Array.from(
		new Set(
			(args.runtime.actions ?? [])
				.map((action) => action.name?.trim())
				.filter((name): name is string => Boolean(name)),
		),
	).sort();

	if (availableActionNames.length === 0) {
		return null;
	}

	const repairPrompt = buildCanonicalActionRepairPrompt({
		userText: String(args.message.content.text ?? ""),
		rawPlannerActions: args.rawPlannerActions,
		rawPlannerProviders: args.rawPlannerProviders,
		plannerReplyText: args.plannerReplyText,
		availableActionNames,
	});

	const repairResponse = await args.runtime.useModel(ModelType.TEXT_LARGE, {
		prompt: repairPrompt,
	});

	return parseKeyValueXml<Record<string, unknown>>(repairResponse);
}

function shouldRunProviderFollowup(
	responseContent: Pick<Content, "actions" | "providers"> | null | undefined,
): boolean {
	if (!responseContent?.providers?.length) {
		return false;
	}

	const normalizedActions = (responseContent.actions ?? [])
		.map((actionName) =>
			typeof actionName === "string"
				? normalizeActionIdentifier(actionName)
				: "",
		)
		.filter((actionName) => actionName.length > 0);

	if (normalizedActions.length === 0) {
		return true;
	}

	return normalizedActions.every((actionName) =>
		PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(actionName),
	);
}

function buildProviderFollowupPrompt(basePrompt: string): string {
	return `${basePrompt}

[PROVIDER FOLLOW-UP]
The requested providers have already been executed, and their grounded results are now present in context above.
Use those provider results to produce the final reply and/or action plan for this turn.
Do not ask for the same providers again.
If the provider results fully answer the user, reply directly.
If KNOWLEDGE contains a direct answer, prefer that grounded answer even when AVAILABLE_DOCUMENTS lists multiple files.
Do not ask "which file?" when the grounded KNOWLEDGE result already resolves the request.`;
}

function shouldAttemptProviderRescue(
	responseContent: Pick<Content, "actions" | "providers"> | null | undefined,
): boolean {
	if (!responseContent) {
		return false;
	}

	if ((responseContent.providers?.length ?? 0) > 0) {
		return false;
	}

	const normalizedActions = (responseContent.actions ?? [])
		.map((actionName) =>
			typeof actionName === "string"
				? normalizeActionIdentifier(actionName)
				: "",
		)
		.filter((actionName) => actionName.length > 0);

	if (normalizedActions.length === 0) {
		return true;
	}

	return normalizedActions.every((actionName) =>
		PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(actionName),
	);
}

function buildProviderSelectionPrompt(draftReply?: string): string {
	const trimmedDraftReply = draftReply?.trim() ?? "";
	const draftReplySection =
		trimmedDraftReply.length > 0
			? `draft_reply:\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n\n`
			: "";
	const draftReplyRules =
		trimmedDraftReply.length > 0
			? [
					"- if the draft reply asks the user to resend, restate, or clarify information that may already exist in provider context, choose the relevant providers instead of sending the draft reply as-is",
					'- when the recent conversation already identifies a prior upload or knowledge-base question, prefer grounded provider lookup over asking "which file?" again',
				]
			: [];
	return `task: Decide whether any providers should be called before sending the assistant's reply.

available provider catalog:
{{providers}}

recent conversation:
{{recentMessages}}

${draftReplySection}rules[${4 + draftReplyRules.length}]:
- choose providers only when they can supply grounded information needed before the assistant replies
- uploaded files, documents, prior uploads, and knowledge-base questions should use the relevant providers before asking the user to resend the material
- if the user asks about an uploaded file or document and AVAILABLE_DOCUMENTS is available, prefer AVAILABLE_DOCUMENTS together with KNOWLEDGE before sending any clarification reply
- return an empty providers field when no provider lookup is needed
- do not include actions, text, or thought in the output
${draftReplyRules.join("\n")}

output:
Return JSON or XML containing only provider names. No prose before or after it. No <think>.

Examples:
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "Which file are you referring to?"
  output: {"providers":["AVAILABLE_DOCUMENTS","KNOWLEDGE"]}
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "I don't have the file in my context. Which file contains the QA codeword?"
  output: {"providers":["AVAILABLE_DOCUMENTS","KNOWLEDGE"]}
- user asks: "thanks, that's all"
  draft reply: "Glad to help."
  output: {"providers":[]}`;
}

async function recoverProvidersForTurn(args: {
	runtime: IAgentRuntime;
	state: State;
	draftReply?: string;
	attachments?: GenerateTextAttachment[];
}): Promise<string[]> {
	const prompt = composePromptFromState({
		state: args.state,
		template: buildProviderSelectionPrompt(args.draftReply),
	});

	try {
		const result = await args.runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			...(args.attachments ? { attachments: args.attachments } : {}),
		});
		const rawResponse = typeof result === "string" ? result : "";
		const parsed =
			parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
			parseJSONObjectFromText(rawResponse);
		const normalizedProviders = normalizePlannerProviders(
			parsed ?? { providers: rawResponse },
			args.runtime,
		);
		if (normalizedProviders.length > 0) {
			return normalizedProviders;
		}
		const shouldUseKnowledge = await shouldUseKnowledgeProviders(
			args.runtime,
			args.state,
			args.attachments,
		);
		return shouldUseKnowledge ? ["AVAILABLE_DOCUMENTS", "KNOWLEDGE"] : [];
	} catch (error) {
		args.runtime.logger.warn(
			{
				src: "service:message",
				error: error instanceof Error ? error.message : String(error),
			},
			"Provider rescue model call failed",
		);
		return [];
	}
}

function buildGroundedFallbackReplyPrompt(): string {
	return `task: Write the next assistant reply using grounded context.

grounded context:
{{providers}}

recent conversation:
{{recentMessages}}

rules[5]:
- answer directly from grounded context when it fully answers the user
- do not ask the user to resend, rename, or specify a file if grounded document or knowledge context already answers the request
- do not say you cannot access the file when grounded context is already present above
- if KNOWLEDGE contains a direct answer, prefer that grounded answer even when AVAILABLE_DOCUMENTS lists multiple files
- if grounded context is still insufficient, say exactly what is missing
- return only the reply text

output:
Plain text only. No XML, JSON, TOON, bullets, or <think>.`;
}

function buildKnowledgeProviderDecisionPrompt(): string {
	return `task: Decide whether the assistant should consult uploaded-document or knowledge providers before replying.

available provider catalog:
{{providers}}

recent conversation:
{{recentMessages}}

rules[5]:
- return true when the user is asking about an uploaded file, document, prior upload, or knowledge-base content
- return true when the answer is likely already stored in uploaded documents or semantic knowledge search
- when AVAILABLE_DOCUMENTS or KNOWLEDGE is available and the user refers to an uploaded file or prior upload, return true
- return false for generic chat, thanks, or requests that clearly do not depend on uploaded or knowledge-base content
- return only the structured output, with no prose

output:
Return JSON or XML only.

Examples:
- user asks: "what is the qa codeword from the uploaded file?" -> {"useKnowledgeProviders":true}
- user asks: "thanks, that's all" -> {"useKnowledgeProviders":false}`;
}

async function shouldUseKnowledgeProviders(
	runtime: IAgentRuntime,
	state: State,
	attachments?: GenerateTextAttachment[],
): Promise<boolean> {
	const prompt = composePromptFromState({
		state,
		template: buildKnowledgeProviderDecisionPrompt(),
	});

	try {
		const result = await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			...(attachments ? { attachments } : {}),
		});
		const rawResponse = typeof result === "string" ? result : "";
		const parsed =
			parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
			parseJSONObjectFromText(rawResponse);
		const value =
			parsed?.useKnowledgeProviders ??
			parsed?.use_knowledge_providers ??
			rawResponse;
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "string") {
			return value.trim().toLowerCase() === "true";
		}
		return false;
	} catch (error) {
		runtime.logger.warn(
			{
				src: "service:message",
				error: error instanceof Error ? error.message : String(error),
			},
			"Knowledge provider decision model call failed",
		);
		return false;
	}
}

function buildRuntimeActionLookup(runtime: IAgentRuntime): Map<string, Action> {
	const actionMap = new Map<string, Action>();

	for (const action of runtime.actions ?? []) {
		const identifiers = [action.name, ...(action.similes ?? [])];
		for (const identifier of identifiers) {
			const normalized = normalizeActionIdentifier(identifier);
			if (!normalized || actionMap.has(normalized)) {
				continue;
			}
			actionMap.set(normalized, action);
		}
	}

	return actionMap;
}

function resolveRuntimeAction(
	actionLookup: Map<string, Action>,
	actionName: string,
): Action | undefined {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return undefined;
	}

	return actionLookup.get(normalized);
}

const TERMINAL_ACTION_IDENTIFIERS = new Set(
	[
		"REPLY",
		"IGNORE",
		"STOP",
		"CREATE_TASK",
		"START_CODING_TASK",
		"CODE_TASK",
		"SPAWN_AGENT",
		"SPAWN_CODING_AGENT",
	].map(normalizeActionIdentifier),
);

function shouldContinueAfterActions(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	// Async background/task actions handle their own follow-up and should not
	// trigger an immediate continuation loop from the main message service.
	const actionLookup = buildRuntimeActionLookup(runtime);
	return !!responseContent?.actions?.some((action) => {
		if (typeof action !== "string") return false;

		const resolvedAction = resolveRuntimeAction(actionLookup, action);
		if (resolvedAction?.suppressPostActionContinuation) {
			return false;
		}

		const canonicalAction = resolvedAction?.name ?? action;
		return !TERMINAL_ACTION_IDENTIFIERS.has(
			normalizeActionIdentifier(canonicalAction),
		);
	});
}

function suppressesPostActionContinuation(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	if (!responseContent?.actions?.length) {
		return false;
	}

	const actionLookup = buildRuntimeActionLookup(runtime);
	return responseContent.actions.some((action) => {
		if (typeof action !== "string") return false;
		return (
			resolveRuntimeAction(actionLookup, action)
				?.suppressPostActionContinuation === true
		);
	});
}

/**
 * True when the planner's `text` field should be surfaced to the user as a
 * preamble before action handlers run in actions-mode dispatch. The goal:
 * the user sees "checking your inbox" rather than silence while INBOX/GMAIL
 * do their work.
 *
 * Skipped when the first action is REPLY (the REPLY handler generates its own
 * text), IGNORE (no user-visible response), or STOP (terminal). Also skipped
 * when `text` is empty.
 */
export function shouldEmitPlannerPreamble(
	runtime: IAgentRuntime,
	responseContent: Pick<Content, "text" | "actions"> | null | undefined,
): boolean {
	if (!responseContent) return false;
	const text =
		typeof responseContent.text === "string" ? responseContent.text.trim() : "";
	if (text.length === 0) return false;

	const firstAction =
		typeof responseContent.actions?.[0] === "string"
			? responseContent.actions[0]
			: "";
	if (firstAction.length === 0) return false;

	const actionLookup = buildRuntimeActionLookup(runtime);
	const resolvedAction = resolveRuntimeAction(actionLookup, firstAction);
	if (resolvedAction?.suppressPostActionContinuation) {
		return false;
	}

	const normalizedFirstAction = normalizeActionIdentifier(firstAction);

	return (
		normalizedFirstAction !== normalizeActionIdentifier("REPLY") &&
		normalizedFirstAction !== normalizeActionIdentifier("IGNORE") &&
		normalizedFirstAction !== normalizeActionIdentifier("STOP")
	);
}

function callbackTextPreview(content: Content | null | undefined): string {
	if (!content || typeof content !== "object") {
		return "";
	}

	const text = typeof content.text === "string" ? content.text.trim() : "";
	if (!text) {
		return "";
	}

	return text.replace(/\s+/g, " ").slice(0, 200);
}

function summarizeAttachmentKeyPart(url: string): string {
	const trimmed = url.trim();
	if (trimmed.length <= 256) {
		return trimmed;
	}

	return `${trimmed.slice(0, 128)}...(${trimmed.length})`;
}

function callbackDeliveryKey(content: Content | null | undefined): string {
	if (!content || typeof content !== "object") {
		return "";
	}

	const text =
		typeof content.text === "string"
			? content.text.replace(/\s+/g, " ").trim()
			: "";
	const attachmentKeys = Array.isArray(content.attachments)
		? content.attachments
				.map((attachment) => {
					if (!attachment || typeof attachment !== "object") {
						return "";
					}

					const url =
						typeof attachment.url === "string"
							? summarizeAttachmentKeyPart(attachment.url)
							: "";
					const title =
						typeof attachment.title === "string" ? attachment.title.trim() : "";
					const contentType =
						typeof attachment.contentType === "string"
							? attachment.contentType
							: "";

					if (!url && !title && !contentType) {
						return "";
					}

					return `${contentType}:${title}:${url}`;
				})
				.filter((key) => key.length > 0)
				.sort()
		: [];

	if (!text && attachmentKeys.length === 0) {
		return "";
	}

	return JSON.stringify({
		text,
		attachments: attachmentKeys,
	});
}

function getLatestVisibleReplyText(
	responseContent: Content | null | undefined,
	actionResults: ActionResult[],
): string {
	for (let index = actionResults.length - 1; index >= 0; index--) {
		const result = actionResults[index];
		const actionName =
			typeof result?.data?.actionName === "string"
				? result.data.actionName
				: "";
		if (normalizeActionIdentifier(actionName) !== "REPLY") {
			continue;
		}

		if (typeof result.text === "string" && result.text.trim().length > 0) {
			return result.text.trim();
		}
	}

	const responseText =
		typeof responseContent?.text === "string"
			? responseContent.text.trim()
			: "";
	return responseText;
}

function isLikelyClarifyingQuestion(text: string): boolean {
	const normalized = text.trim();
	if (!normalized) {
		return false;
	}

	if (/[?؟]\s*$/.test(normalized)) {
		return true;
	}

	const firstSentence = extractFirstSentence(normalized)
		.first.trim()
		.toLowerCase();
	return /^(what|which|when|where|who|whom|whose|why|how|can you|could you|would you|will you|do you|did you|are you|is it|should i|should we)\b/.test(
		firstSentence,
	);
}

function shouldWaitForUserAfterIncompleteReflection(
	responseContent: Content | null | undefined,
	actionResults: ActionResult[],
): boolean {
	const latestVisibleReply = getLatestVisibleReplyText(
		responseContent,
		actionResults,
	);
	if (!isLikelyClarifyingQuestion(latestVisibleReply)) {
		return false;
	}

	if (actionResults.length === 0) {
		return isSimpleReplyResponse(responseContent);
	}

	return actionResults.every((result) => {
		const actionName =
			typeof result?.data?.actionName === "string"
				? result.data.actionName
				: "";
		return normalizeActionIdentifier(actionName) === "REPLY";
	});
}

function formatActionResultsForPrompt(actionResults: ActionResult[]): string {
	if (actionResults.length === 0) {
		return "No action results available.";
	}

	return [
		"# Action Results",
		...actionResults.map((result, index) => {
			const actionNameValue = result.data?.actionName;
			const actionName =
				typeof actionNameValue === "string"
					? actionNameValue
					: "Unknown Action";
			const lines = [
				`${index + 1}. ${actionName} - ${result.success === false ? "failed" : "succeeded"}`,
			];
			if (typeof result.text === "string" && result.text.trim()) {
				lines.push(`Output: ${result.text.trim().slice(0, 2000)}`);
			}
			if (result.error) {
				const errorText =
					result.error instanceof Error
						? result.error.message
						: String(result.error);
				lines.push(`Error: ${errorText.slice(0, 1000)}`);
			}
			return lines.join("\n");
		}),
	].join("\n\n");
}

function withActionResults(state: State, actionResults: ActionResult[]): State {
	return {
		...state,
		values: {
			...state.values,
			actionResults: formatActionResultsForPrompt(actionResults),
		},
		data: {
			...state.data,
			actionResults,
		},
	};
}

function withTaskCompletion(
	state: State,
	taskCompletion: TaskCompletionAssessment | null | undefined,
): State {
	if (!taskCompletion) {
		return state;
	}

	return {
		...state,
		values: {
			...state.values,
			taskCompletionStatus: formatTaskCompletionStatus(taskCompletion),
			taskCompleted: taskCompletion.completed,
			taskCompletionAssessed: taskCompletion.assessed,
			taskCompletionReason: taskCompletion.reason,
		},
		data: {
			...state.data,
			taskCompletion,
		},
	};
}

function getStructuredOutputFailure(
	state: State,
): StructuredOutputFailure | null {
	const candidate = state.data?.structuredOutputFailure;
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	return candidate as StructuredOutputFailure;
}

function summarizeStructuredOutputFailure(
	failure: StructuredOutputFailure | null,
): string {
	if (!failure) {
		return "Structured output parsing failed, but no additional diagnostics were recorded.";
	}

	const parts = [
		`Kind: ${failure.kind}`,
		`Model: ${failure.model}`,
		`Format: ${failure.format}`,
		`Attempts: ${failure.attempts}/${failure.maxRetries + 1}`,
	];

	if (failure.key) {
		parts.push(`Key: ${failure.key}`);
	}
	if (failure.parseError) {
		parts.push(`Error: ${failure.parseError}`);
	}
	if (failure.issues && failure.issues.length > 0) {
		parts.push(`Issues: ${failure.issues.join(" | ")}`);
	}
	if (failure.responsePreview) {
		parts.push(`Response Preview:\n${failure.responsePreview}`);
	}

	return parts.join("\n");
}

function summarizeActionResultsForUser(actionResults: ActionResult[]): string {
	if (actionResults.length === 0) {
		return "";
	}

	const summary = actionResults
		.slice(-3)
		.map((result) => {
			const actionName =
				typeof result.data?.actionName === "string"
					? result.data.actionName
					: "unknown action";
			return `${actionName} (${result.success === false ? "failed" : "succeeded"})`;
		})
		.join(", ");

	return `Completed action state before the error: ${summary}.`;
}

type ContextRoutingStateValues = {
	[AVAILABLE_CONTEXTS_STATE_KEY]?: unknown;
	[CONTEXT_ROUTING_STATE_KEY]?: unknown;
};

function withContextRoutingValues(
	state: State,
	contextRoutingStateValues?: ContextRoutingStateValues,
): State {
	if (!contextRoutingStateValues) {
		return state;
	}

	const mergedStateValues = {
		...state.values,
	};

	if (contextRoutingStateValues[AVAILABLE_CONTEXTS_STATE_KEY] !== undefined) {
		mergedStateValues[AVAILABLE_CONTEXTS_STATE_KEY] = contextRoutingStateValues[
			AVAILABLE_CONTEXTS_STATE_KEY
		] as State["values"][string];
	}

	if (contextRoutingStateValues[CONTEXT_ROUTING_STATE_KEY] !== undefined) {
		mergedStateValues[CONTEXT_ROUTING_STATE_KEY] = contextRoutingStateValues[
			CONTEXT_ROUTING_STATE_KEY
		] as State["values"][string];
	}

	return {
		...state,
		values: mergedStateValues,
	};
}

async function composeContinuationDecisionState(
	runtime: IAgentRuntime,
	message: Memory,
	contextRoutingStateValues?: ContextRoutingStateValues,
): Promise<State> {
	// Continuation prompts run after the runtime has already persisted an
	// assistant reply and/or action_result memories. Refresh RECENT_MESSAGES so
	// the follow-up planner does not reuse stale conversation history cached on
	// the original user turn.
	return withContextRoutingValues(
		await runtime.composeState(
			message,
			["RECENT_MESSAGES", "ACTIONS"],
			false,
			false,
		),
		contextRoutingStateValues,
	);
}

function withoutProviders(state: State, providerNamesToOmit: string[]): State {
	if (providerNamesToOmit.length === 0) {
		return state;
	}

	const omittedProviderNames = new Set(
		providerNamesToOmit.map((providerName) =>
			providerName.trim().toUpperCase(),
		),
	);
	const providerResults =
		typeof state.data?.providers === "object" && state.data?.providers !== null
			? (state.data.providers as Record<string, ProviderCacheEntry>)
			: {};
	const providerOrder = Array.isArray(state.data?.providerOrder)
		? (state.data.providerOrder as string[])
		: Object.keys(providerResults);
	const filteredProviderOrder = providerOrder.filter(
		(providerName) => !omittedProviderNames.has(providerName.toUpperCase()),
	);
	const filteredProviderResults = Object.fromEntries(
		Object.entries(providerResults).filter(
			([providerName]) =>
				!omittedProviderNames.has(providerName.trim().toUpperCase()),
		),
	);
	const filteredProvidersText = filteredProviderOrder
		.map((providerName) => filteredProviderResults[providerName]?.text)
		.filter(
			(text): text is string => typeof text === "string" && text.trim() !== "",
		)
		.join("\n");

	return {
		...state,
		values: {
			...state.values,
			providers: filteredProvidersText,
		},
		data: {
			...state.data,
			providerOrder: filteredProviderOrder,
			providers: filteredProviderResults,
		},
		text: filteredProvidersText,
	};
}

function buildShouldRespondCharacterText(
	providerResult:
		| {
				text?: string;
				values?: Record<string, StateValue>;
		  }
		| undefined,
): string {
	if (!providerResult) {
		return "";
	}

	const values =
		typeof providerResult.values === "object" && providerResult.values !== null
			? providerResult.values
			: {};
	const bio = typeof values.bio === "string" ? values.bio : "";
	const directions =
		typeof values.directions === "string" ? values.directions : "";
	const system = typeof values.system === "string" ? values.system : "";
	const classifierText = [bio, directions, system]
		.filter((section) => section.trim().length > 0)
		.join("\n\n");

	return (
		classifierText ||
		(typeof providerResult.text === "string" ? providerResult.text : "")
	);
}

function prepareShouldRespondState(state: State): State {
	const stateWithoutActions = withoutProviders(state, ["ACTIONS"]);
	const providerResults =
		typeof stateWithoutActions.data?.providers === "object" &&
		stateWithoutActions.data?.providers !== null
			? ({
					...stateWithoutActions.data.providers,
				} as Record<string, ProviderCacheEntry>)
			: null;

	if (!providerResults?.CHARACTER) {
		return stateWithoutActions;
	}

	providerResults.CHARACTER = {
		...providerResults.CHARACTER,
		text: buildShouldRespondCharacterText(providerResults.CHARACTER),
	};

	const providerOrder = Array.isArray(stateWithoutActions.data?.providerOrder)
		? (stateWithoutActions.data.providerOrder as string[])
		: Object.keys(providerResults);
	const providersText = providerOrder
		.map((providerName) => providerResults[providerName]?.text)
		.filter(
			(text): text is string => typeof text === "string" && text.trim() !== "",
		)
		.join("\n");

	return {
		...stateWithoutActions,
		values: {
			...stateWithoutActions.values,
			providers: providersText,
		},
		data: {
			...stateWithoutActions.data,
			providers: providerResults,
		},
		text: providersText,
	};
}

function isBenchmarkMode(state: Pick<State, "values">): boolean {
	const benchmarkFlag = state.values?.benchmark_has_context;
	if (typeof benchmarkFlag === "boolean") {
		return benchmarkFlag;
	}

	if (typeof benchmarkFlag === "string") {
		return parseBooleanFromText(benchmarkFlag);
	}

	return false;
}

/**
 * Default implementation of the MessageService interface.
 * This service handles the complete message processing pipeline including:
 * - Message validation and memory creation
 * - Smart response decision (shouldRespond)
 * - Single-shot or multi-step processing strategies
 * - Action execution and evaluation
 * - Attachment processing
 * - Message deletion and channel clearing
 *
 * This is the standard message handler used by elizaOS and can be replaced
 * with custom implementations via the IMessageService interface.
 */
export class DefaultMessageService implements IMessageService {
	/**
	 * Main message handling entry point
	 */
	async handleMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback?: HandlerCallback,
		options?: MessageProcessingOptions,
	): Promise<MessageProcessingResult> {
		const source =
			typeof message.content?.source === "string" &&
			message.content.source.trim() !== ""
				? message.content.source
				: "messageService";

		let trajectoryStepId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;

		if (
			!(typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== "")
		) {
			try {
				await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
					runtime,
					message,
					callback,
					source,
				});
			} catch (error) {
				runtime.logger.warn(
					{
						src: "service:message",
						agentId: runtime.agentId,
						entityId: message.entityId,
						roomId: message.roomId,
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to emit MESSAGE_RECEIVED before handling message",
				);
			}

			trajectoryStepId =
				typeof message.metadata === "object" &&
				message.metadata !== null &&
				"trajectoryStepId" in message.metadata
					? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
					: undefined;
		}

		return await runWithTrajectoryContext<MessageProcessingResult>(
			typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== ""
				? {
						trajectoryStepId: trajectoryStepId.trim(),
						runId: runtime.getCurrentRunId?.(),
						roomId: message.roomId,
						messageId: message.id,
					}
				: undefined,
			async (): Promise<MessageProcessingResult> => {
				// Determine shouldRespondModel from options or runtime settings
				const shouldRespondModelSetting = runtime.getSetting(
					"SHOULD_RESPOND_MODEL",
				);
				const resolvedShouldRespondModel = normalizeShouldRespondModelType(
					options?.shouldRespondModel ?? shouldRespondModelSetting,
				);

				// Single ID used for tracking, streaming, and the final message (before opts / chunk wrapper).
				const responseId = asUUID(v4());

				// WHY voice detection wraps onStreamChunk here instead of using a
				// separate ResponseStreamExtractor + AsyncLocalStorage context:
				//
				// Previously handleMessage created a second XML extractor
				// (ResponseStreamExtractor) and injected it via runWithStreamingContext.
				// Both extractors received the same raw LLM tokens in useModel and
				// emitted independently, causing the dual-extractor garbling bug —
				// consumers saw overlapping deltas that produced unintelligible TTS.
				//
				// The fix: a single extractor (ValidationStreamExtractor in
				// dynamicPromptExecFromState) now provides `accumulated` — the full
				// extracted text — via the third StreamChunkCallback argument. Voice
				// detection wraps the caller's callback to intercept accumulated text
				// for first-sentence detection, then forwards to the original. This
				// keeps voice logic in handleMessage (encapsulation) without adding a
				// second extraction pipeline.
				//
				// The `streamTextFallback` path exists for action handlers or other
				// call sites that don't provide `accumulated` (raw token streams).
				let firstSentenceSent = false;
				let streamTextFallback = "";
				const userOnStreamChunk = options?.onStreamChunk;
				const wrappedOnStreamChunk: StreamChunkCallback | undefined =
					userOnStreamChunk
						? async (chunk, messageId, accumulated) => {
								let streamText: string;
								// If we have accumulated text, also sync streamTextFallback so the
								// fallback path has accurate state if the stream source later changes.
								if (accumulated !== undefined) {
									streamTextFallback = accumulated;
									streamText = accumulated;
								} else {
									streamTextFallback += chunk;
									streamText = streamTextFallback;
								}

								// Skip when this callback is invoked from `useModel`'s stream loop:
								// `source: "use_model"` already ran for the same raw chunk (Node ALS).
								if (getModelStreamChunkDeliveryDepth() === 0) {
									await runtime.applyPipelineHooks(
										"model_stream_chunk",
										modelStreamChunkPipelineHookContext({
											source: "message_service",
											chunk,
											messageId,
											roomId: message.roomId,
											runId: runtime.getCurrentRunId(),
											responseId,
											accumulated,
										}),
									);
								}

								// Only run first-sentence TTS detection when `accumulated` is present.
								// Raw-token streams (no accumulated) may contain XML markup or partial
								// structured output that would garble hasFirstSentence() and TTS.
								if (
									!firstSentenceSent &&
									accumulated !== undefined &&
									hasFirstSentence(streamText)
								) {
									const { first } = extractFirstSentence(streamText);
									if (first.length > 5) {
										firstSentenceSent = true;

										(async () => {
											try {
												const voiceSettings = runtime.character.settings
													?.voice as
													| {
															model?: string;
															url?: string;
															voiceId?: string;
													  }
													| undefined;

												const model =
													voiceSettings?.model || "en_US-male-medium";
												const voiceId =
													voiceSettings?.url ||
													voiceSettings?.voiceId ||
													"nova";

												let audioBuffer: Buffer | null = null;
												const params: TextToSpeechParams & {
													model?: string;
												} = {
													text: first,
													voice: voiceId,
													model: model,
												};
												const result = runtime.getModel(
													ModelType.TEXT_TO_SPEECH,
												)
													? await runtime.useModel(
															ModelType.TEXT_TO_SPEECH,
															params,
														)
													: undefined;

												if (
													result instanceof ArrayBuffer ||
													Object.prototype.toString.call(result) ===
														"[object ArrayBuffer]"
												) {
													audioBuffer = Buffer.from(result as ArrayBuffer);
												} else if (Buffer.isBuffer(result)) {
													audioBuffer = result;
												} else if (result instanceof Uint8Array) {
													audioBuffer = Buffer.from(result);
												}

												if (audioBuffer && callback) {
													const audioBase64 = audioBuffer.toString("base64");
													await callback({
														text: "",
														attachments: [
															{
																id: v4(),
																url: `data:audio/wav;base64,${audioBase64}`,
																title: "Voice Response",
																source: "voice-cache",
																description:
																	"Voice response for first sentence",
																text: first,
																contentType: ContentType.AUDIO,
															},
														],
														source: "voice",
													});
												}
											} catch (error) {
												runtime.logger.error(
													{ error },
													"Error generating voice for first sentence",
												);
											}
										})();
									}
								}

								await userOnStreamChunk(chunk, messageId, accumulated);
							}
						: undefined;

				const opts: ResolvedMessageOptions = {
					maxRetries: options?.maxRetries ?? 3,
					timeoutDuration: options?.timeoutDuration ?? 60 * 60 * 1000, // 1 hour
					useMultiStep:
						options?.useMultiStep ??
						parseBooleanFromText(
							String(runtime.getSetting("USE_MULTI_STEP") ?? ""),
						),
					maxMultiStepIterations:
						options?.maxMultiStepIterations ??
						parseInt(
							String(runtime.getSetting("MAX_MULTISTEP_ITERATIONS") ?? "6"),
							10,
						),
					continueAfterActions:
						options?.continueAfterActions ??
						parseBooleanFromText(
							String(runtime.getSetting("CONTINUE_AFTER_ACTIONS") ?? "true"),
						),
					onStreamChunk: wrappedOnStreamChunk,
					keepExistingResponses:
						options?.keepExistingResponses ??
						parseBooleanFromText(
							String(runtime.getSetting("BASIC_CAPABILITIES_KEEP_RESP") ?? ""),
						),
					shouldRespondModel: resolvedShouldRespondModel,
				};

				let visibleCallbackCount = 0;
				let firstVisibleCallbackPreview = "";
				const deliveredCallbackKeys = new Set<string>();
				const instrumentedCallback: HandlerCallback | undefined = callback
					? async (content, actionName) => {
							const deliveryKey = callbackDeliveryKey(content);
							const preview = callbackTextPreview(content);
							if (deliveryKey && deliveredCallbackKeys.has(deliveryKey)) {
								runtime.logger.warn(
									{
										src: "service:message",
										agentId: runtime.agentId,
										messageId: message.id,
										roomId: message.roomId,
										action:
											typeof (content as Record<string, unknown>)?.action ===
											"string"
												? String((content as Record<string, unknown>).action)
												: actionName,
										source:
											typeof content.source === "string"
												? content.source
												: undefined,
										preview:
											preview ||
											(Array.isArray(content.attachments) &&
											content.attachments.length > 0
												? `[attachments:${content.attachments.length}]`
												: ""),
									},
									"Suppressing duplicate visible callback reply emitted for a single turn",
								);
								return [];
							}
							if (deliveryKey) {
								deliveredCallbackKeys.add(deliveryKey);
							}
							if (preview) {
								visibleCallbackCount += 1;
								if (visibleCallbackCount === 1) {
									firstVisibleCallbackPreview = preview;
								} else {
									runtime.logger.warn(
										{
											src: "service:message",
											agentId: runtime.agentId,
											messageId: message.id,
											roomId: message.roomId,
											callbackCount: visibleCallbackCount,
											action:
												typeof (content as Record<string, unknown>)?.action ===
												"string"
													? String((content as Record<string, unknown>).action)
													: actionName,
											source:
												typeof content.source === "string"
													? content.source
													: undefined,
											firstPreview: firstVisibleCallbackPreview,
											currentPreview: preview,
										},
										"Multiple visible callback replies emitted for a single turn",
									);
								}
							}

							return actionName === undefined
								? callback(content)
								: callback(content, actionName);
						}
					: undefined;

				// Set up timeout monitoring
				let timeoutId: NodeJS.Timeout | undefined;

				try {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							entityId: message.entityId,
							roomId: message.roomId,
						},
						"Message received",
					);

					// Track this response ID - ensure map exists for this agent
					let agentResponses = latestResponseIds.get(runtime.agentId);
					if (!agentResponses) {
						agentResponses = new Map<string, string>();
						latestResponseIds.set(runtime.agentId, agentResponses);
					}

					const previousResponseId = agentResponses.get(message.roomId);
					if (previousResponseId) {
						logger.debug(
							{
								src: "service:message",
								roomId: message.roomId,
								previousResponseId,
								responseId,
							},
							"Updating response ID",
						);
					}
					agentResponses.set(message.roomId, responseId);

					// Start run tracking with roomId for proper log association
					const runId = runtime.startRun(message.roomId);
					if (!runId) {
						runtime.logger.error("Failed to start run tracking");
						return {
							didRespond: false,
							responseContent: null,
							responseMessages: [],
							state: { values: {}, data: {}, text: "" } as State,
							mode: "none",
						};
					}
					const startTime = Date.now();

					// Emit run started event
					await runtime.emitEvent(EventType.RUN_STARTED, {
						runtime,
						source: "messageHandler",
						runId,
						messageId: message.id,
						roomId: message.roomId,
						entityId: message.entityId,
						startTime,
						status: "started",
					} as RunEventPayload);

					const timeoutPromise = new Promise<never>((_, reject) => {
						timeoutId = setTimeout(async () => {
							await runtime.emitEvent(EventType.RUN_TIMEOUT, {
								runtime,
								source: "messageHandler",
								runId,
								messageId: message.id,
								roomId: message.roomId,
								entityId: message.entityId,
								startTime,
								status: "timeout",
								endTime: Date.now(),
								duration: Date.now() - startTime,
								error: "Run exceeded timeout",
							} as RunEventPayload);
							reject(new Error("Run exceeded timeout"));
						}, opts.timeoutDuration);
					});

					// Wrap processing with streaming context for automatic streaming in useModel calls
					// Use ResponseStreamExtractor to filter XML and only stream <text> (if REPLY) or <message>
					let streamingContext:
						| {
								onStreamChunk: (
									chunk: string,
									messageId?: string,
								) => Promise<void>;
								messageId?: string;
						  }
						| undefined;
					// Voice handling state
					let firstSentenceSent = false;
					let firstSentenceText = "";

					if (opts.onStreamChunk) {
						const extractor = new ResponseStreamExtractor();
						const onStreamChunk = opts.onStreamChunk;

						let streamText = "";

						streamingContext = {
							onStreamChunk: async (chunk: string, msgId?: string) => {
								if (extractor.done) return;
								const textToStream = extractor.push(chunk);
								if (textToStream) {
									streamText += textToStream;

									// Check for first sentence to send to voice
									if (!firstSentenceSent && hasFirstSentence(streamText)) {
										const { first } = extractFirstSentence(streamText);
										firstSentenceText = first;
										if (first.length > 5) {
											// Minimal length check
											firstSentenceSent = true;

											// Process voice in background
											(async () => {
												try {
													const voiceSettings = runtime.character.settings
														?.voice as
														| {
																model?: string;
																url?: string;
																voiceId?: string;
														  }
														| undefined;

													const model =
														voiceSettings?.model || "en_US-male-medium";
													const voiceId =
														voiceSettings?.url ||
														voiceSettings?.voiceId ||
														"nova";

													let audioBuffer: Buffer | null = null;
													const params: TextToSpeechParams & {
														model?: string;
													} = {
														text: first,
														voice: voiceId,
														model: model,
													};
													const result = runtime.getModel(
														ModelType.TEXT_TO_SPEECH,
													)
														? await runtime.useModel(
																ModelType.TEXT_TO_SPEECH,
																params,
															)
														: undefined;

													if (
														result instanceof ArrayBuffer ||
														Object.prototype.toString.call(result) ===
															"[object ArrayBuffer]"
													) {
														audioBuffer = Buffer.from(result as ArrayBuffer);
													} else if (Buffer.isBuffer(result)) {
														audioBuffer = result;
													} else if (result instanceof Uint8Array) {
														audioBuffer = Buffer.from(result);
													}

													if (audioBuffer && instrumentedCallback) {
														const audioBase64 = audioBuffer.toString("base64");
														await instrumentedCallback({
															text: "",
															attachments: [
																{
																	id: v4(),
																	url: `data:audio/wav;base64,${audioBase64}`,
																	title: "Voice Response",
																	source: "voice-cache",
																	description:
																		"Voice response for first sentence",
																	text: first,
																	contentType: ContentType.AUDIO,
																},
															],
															source: "voice",
														});
													}
												} catch (error) {
													runtime.logger.error(
														{ error },
														"Error generating voice for first sentence",
													);
												}
											})();
										}
									}

									await onStreamChunk(textToStream, msgId);
								}
							},
							messageId: responseId,
						};
					}

					const processingPromise = runWithStreamingContext(
						streamingContext,
						() =>
							this.processMessage(
								runtime,
								message,
								instrumentedCallback,
								responseId,
								runId,
								startTime,
								opts,
							),
					);

					const result = await Promise.race([
						processingPromise,
						timeoutPromise,
					]);

					// Clean up timeout
					clearTimeout(timeoutId);

					// Voice: Handle the rest of the message
					if (firstSentenceSent && result.responseContent?.text) {
						const fullText = result.responseContent.text;
						const rest = fullText.replace(firstSentenceText, "").trim();
						if (rest.length > 0) {
							// Generate voice for rest
							// (Async immediately)
							(async () => {
								try {
									const voiceSettings = runtime.character.settings?.voice as
										| {
												model?: string;
												url?: string;
												voiceId?: string;
										  }
										| undefined;
									const model = voiceSettings?.model || "en_US-male-medium";
									const voiceId =
										voiceSettings?.url || voiceSettings?.voiceId || "nova";

									let audioBuffer: Buffer | null = null;
									const params: TextToSpeechParams & {
										model?: string;
									} = {
										text: rest,
										voice: voiceId,
										model: model,
									};
									const result = runtime.getModel(ModelType.TEXT_TO_SPEECH)
										? await runtime.useModel(ModelType.TEXT_TO_SPEECH, params)
										: undefined;
									if (
										result instanceof ArrayBuffer ||
										Object.prototype.toString.call(result) ===
											"[object ArrayBuffer]"
									) {
										audioBuffer = Buffer.from(result as ArrayBuffer);
									} else if (Buffer.isBuffer(result)) {
										audioBuffer = result;
									} else if (result instanceof Uint8Array) {
										audioBuffer = Buffer.from(result);
									}

									if (audioBuffer && instrumentedCallback) {
										const audioBase64 = audioBuffer.toString("base64");
										await instrumentedCallback({
											text: "",
											attachments: [
												{
													id: v4(),
													url: `data:audio/wav;base64,${audioBase64}`,
													title: "Voice Response",
													source: "voice",
													description: "Voice response for remaining text",
													text: rest,
													contentType: ContentType.AUDIO,
												},
											],
											source: "voice",
										});
									}
								} catch (error) {
									runtime.logger.error(
										{ error },
										"Error generating voice for remaining text",
									);
								}
							})();
						}
					}

					return result;
				} finally {
					clearTimeout(timeoutId);

					// Ensure latestResponseIds is cleaned up even if processMessage
					// threw before reaching its own cleanup at the end of the method.
					clearLatestResponseId(runtime.agentId, message.roomId, responseId);
				}
			},
		);
	}

	/**
	 * Internal message processing implementation
	 */
	private async processMessage(
		runtime: IAgentRuntime,
		message: Memory,
		callback: HandlerCallback | undefined,
		responseId: UUID,
		runId: UUID,
		startTime: number,
		opts: ResolvedMessageOptions,
	): Promise<MessageProcessingResult> {
		const agentResponses = latestResponseIds.get(runtime.agentId);
		if (!agentResponses) throw new Error("Agent responses map not found");

		// Skip messages from self (unless it's an autonomous message)
		const isAutonomousMessage =
			message.content?.metadata &&
			typeof message.content.metadata === "object" &&
			(message.content.metadata as Record<string, unknown>).isAutonomous ===
				true;

		if (message.entityId === runtime.agentId && !isAutonomousMessage) {
			runtime.logger.debug(
				{ src: "service:message", agentId: runtime.agentId },
				"Skipping message from self",
			);
			await this.emitRunEnded(runtime, runId, message, startTime, "self");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		runtime.logger.debug(
			{
				src: "service:message",
				messagePreview: truncateToCompleteSentence(
					message.content.text || "",
					50,
				),
			},
			"Processing message",
		);

		// ── Save the incoming message to memory ────────────────────────────
		runtime.logger.debug(
			{ src: "service:message" },
			"Saving message to memory",
		);
		let memoryToQueue: Memory;

		if (message.id) {
			const existingMemory = await runtime.getMemoryById(message.id);
			if (existingMemory) {
				runtime.logger.debug(
					{ src: "service:message" },
					"Memory already exists, skipping creation",
				);
				memoryToQueue = existingMemory;
			} else {
				const createdMemoryId = await runtime.createMemory(message, "messages");
				memoryToQueue = { ...message, id: createdMemoryId };
			}
			await runtime.queueEmbeddingGeneration(memoryToQueue, "high");
		} else {
			const memoryId = await runtime.createMemory(message, "messages");
			message.id = memoryId;
			memoryToQueue = { ...message, id: memoryId };
			await runtime.queueEmbeddingGeneration(memoryToQueue, "normal");
		}

		// Check if LLM is off by default
		const agentUserState = await runtime.getParticipantUserState(
			message.roomId,
			runtime.agentId,
		);
		const defLllmOff = parseBooleanFromText(
			String(runtime.getSetting("BASIC_CAPABILITIES_DEFLLMOFF") || ""),
		);

		if (defLllmOff && agentUserState === null) {
			runtime.logger.debug({ src: "service:message" }, "LLM is off by default");
			await this.emitRunEnded(runtime, runId, message, startTime, "off");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Check if room is muted
		const agentName = runtime.character.name ?? "agent";
		const mentionContext = message.content.mentionContext;
		const explicitlyAddressesAgent =
			mentionContext?.isMention === true ||
			mentionContext?.isReply === true ||
			textContainsAgentName(message.content.text, [
				runtime.character.name,
				runtime.character.username,
			]);
		if (
			agentUserState === "MUTED" &&
			message.content.text &&
			!explicitlyAddressesAgent &&
			!message.content.text.toLowerCase().includes(agentName.toLowerCase())
		) {
			runtime.logger.debug(
				{ src: "service:message", roomId: message.roomId },
				"Ignoring muted room",
			);
			await this.emitRunEnded(runtime, runId, message, startTime, "muted");
			return {
				didRespond: false,
				responseContent: null,
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
			};
		}

		// Room context for shouldRespond (fetch before compose so providers see
		// post-attachment and post-incoming-hook message state).
		const room = await runtime.getRoom(message.roomId);

		// Process attachments before state composition / incoming hooks
		if (message.content.attachments && message.content.attachments.length > 0) {
			message.content.attachments = await this.processAttachments(
				runtime,
				message.content.attachments,
			);
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: {
						...message.content,
						attachments: sanitizeAttachmentsForStorage(
							message.content.attachments,
						),
					},
				});
			}
		}

		const preIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		await runtime.applyPipelineHooks(
			"incoming_before_compose",
			incomingPipelineHookContext(message, {
				roomId: message.roomId,
				responseId,
				runId,
			}),
		);

		const postIncomingHookText =
			typeof message.content?.text === "string" ? message.content.text : "";

		if (message.id && postIncomingHookText !== preIncomingHookText) {
			await runtime.updateMemory({
				id: message.id,
				content: message.content,
			});
			await runtime.queueEmbeddingGeneration(
				{ ...message, id: message.id },
				"normal",
			);
		}

		const promptAttachments = resolvePromptAttachments(
			message.content.attachments,
		);

		// Compose initial state (after incoming hooks so providers/actions text matches this turn)
		let state = await composeResponseState(runtime, message);
		state = attachAvailableContexts(state, runtime);

		const metadata =
			typeof message.content.metadata === "object" &&
			message.content.metadata !== null
				? (message.content.metadata as Record<string, unknown>)
				: null;
		const isAutonomous = metadata?.isAutonomous === true;
		const autonomyMode =
			typeof metadata?.autonomyMode === "string" ? metadata.autonomyMode : null;

		await runtime.applyPipelineHooks(
			"pre_should_respond",
			preShouldRespondPipelineHookContext(message, {
				roomId: message.roomId,
				responseId,
				runId,
				state,
				isAutonomous,
			}),
		);

		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		let routedDecision: ContextRoutingDecision | null = null;
		let dualPressureLog: DualPressureScores | null = null;
		let shouldRespondClassifierAction: string | null = null;

		const parallelJoin: { translatedUserText?: string } = {};
		const setTranslatedUserText = (text: string) => {
			parallelJoin.translatedUserText = text;
		};
		const parallelHookCtx = parallelWithShouldRespondPipelineHookContext({
			roomId: message.roomId,
			responseId,
			runId,
			message,
			state,
			room: room ?? undefined,
			mentionContext,
			isAutonomous,
			setTranslatedUserText,
		});

		if (isAutonomous) {
			runtime.logger.debug(
				{ src: "service:message", autonomyMode },
				"Autonomy message bypassing shouldRespond checks",
			);
			shouldRespondToMessage = true;
			await runtime.applyPipelineHooks(
				"parallel_with_should_respond",
				parallelHookCtx,
			);
		} else {
			const [classifyOutcome] = await Promise.all([
				this.runNonAutonomousShouldRespondClassify(
					runtime,
					message,
					state,
					room ?? undefined,
					mentionContext,
					opts,
					promptAttachments,
				),
				runtime.applyPipelineHooks(
					"parallel_with_should_respond",
					parallelHookCtx,
				),
			]);
			shouldRespondToMessage = classifyOutcome.shouldRespondToMessage;
			terminalDecision = classifyOutcome.terminalDecision;
			routedDecision = classifyOutcome.routedDecision;
			dualPressureLog = classifyOutcome.dualPressureLog;
			shouldRespondClassifierAction =
				classifyOutcome.shouldRespondClassifierAction;
			state = classifyOutcome.state;
		}

		const joinedTranslation =
			typeof parallelJoin.translatedUserText === "string"
				? parallelJoin.translatedUserText
				: undefined;
		if (
			joinedTranslation !== undefined &&
			joinedTranslation !== message.content.text
		) {
			message.content.text = joinedTranslation;
			if (message.id) {
				await runtime.updateMemory({
					id: message.id,
					content: message.content,
				});
				await runtime.queueEmbeddingGeneration(
					{ ...message, id: message.id },
					"normal",
				);
			}
			if (message.id) {
				runtime.stateCache.delete(message.id);
				runtime.stateCache.delete(`${message.id}_action_results`);
			}
			state = await composeResponseState(runtime, message);
			state = attachAvailableContexts(state, runtime);
		}

		let responseContent: Content | null = null;
		let responseMessages: Memory[] = [];
		let mode: StrategyMode = "none";
		// Holds a deferred simple-mode reply that will be flushed after
		// evaluators + reflection have had a chance to override it. Declared
		// out here so the post-evaluation flush at the bottom of handleMessage
		// can see the same variable that the simple-mode branch sets.
		let pendingSimpleEmit: Content | null = null;
		// Track memory IDs created for the simple-mode reply so we can clean
		// them up if reflection overrides the deferred emit (Greptile P1 fix).
		let pendingSimpleMemoryIds: string[] = [];

		if (shouldRespondToMessage) {
			const resolvedRouting = mergeContextRouting(state, message);
			let executionState = state;
			if (routedDecision) {
				executionState = withContextRoutingValues(
					await runtime.composeState(
						message,
						["ACTIONS", "PROVIDERS"],
						false,
						false,
					),
					{
						[AVAILABLE_CONTEXTS_STATE_KEY]:
							state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
						[CONTEXT_ROUTING_STATE_KEY]: resolvedRouting,
					},
				);
			}

			const result = opts.useMultiStep
				? await this.runMultiStepCore(
						runtime,
						message,
						executionState,
						callback,
						opts,
						responseId,
						promptAttachments,
						{
							precomposedState: executionState,
						},
					)
				: await this.runSingleShotCore(
						runtime,
						message,
						executionState,
						opts,
						responseId,
						promptAttachments,
						{
							precomposedState: executionState,
						},
					);

			responseContent = result.responseContent;
			responseMessages = result.responseMessages;
			state = result.state;
			mode = result.mode;

			// Race check before we send anything
			const currentResponseId = agentResponses.get(message.roomId);
			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						roomId: message.roomId,
					},
					"Response discarded - newer message being processed",
				);
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			if (responseContent && message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			const providerStateValues = {
				[AVAILABLE_CONTEXTS_STATE_KEY]:
					state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
				[CONTEXT_ROUTING_STATE_KEY]:
					state.values?.[CONTEXT_ROUTING_STATE_KEY],
			};

			if (responseContent?.providers && responseContent.providers.length > 0) {
				state = withContextRoutingValues(
					await composeProviderGroundedResponseState(
						runtime,
						message,
						responseContent.providers,
					),
					providerStateValues,
				);
			}

				if (responseContent && shouldRunProviderFollowup(responseContent)) {
					const providerFollowupState =
						responseContent.providers && responseContent.providers.length > 0
							? withContextRoutingValues(
									await composeFocusedProviderReplyState(
										runtime,
										message,
										responseContent.providers,
									),
									providerStateValues,
								)
							: state;
					runtime.logger.info(
						{
							src: "service:message",
							providers: responseContent.providers ?? [],
							actions: responseContent.actions ?? [],
						},
						"Running provider follow-up pass",
					);
					const providerContinuation = await this.runSingleShotCore(
						runtime,
						message,
						providerFollowupState,
						opts,
						responseId,
						promptAttachments,
						{
							precomposedState: providerFollowupState,
							failureStage: "answering from requested provider results",
							providerFollowup: true,
						},
					);
				responseContent = providerContinuation.responseContent;
				responseMessages = providerContinuation.responseMessages;
				state = providerContinuation.state;
				mode = providerContinuation.mode;

					if (responseContent && message.id) {
						responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
					}

					runtime.logger.info(
						{
							src: "service:message",
							finalActions: responseContent?.actions ?? [],
							finalProviders: responseContent?.providers ?? [],
							hasText:
								typeof responseContent?.text === "string" &&
								responseContent.text.length > 0,
						},
						"Provider follow-up pass completed",
					);

					if (responseContent?.providers && responseContent.providers.length > 0) {
					state = withContextRoutingValues(
						await runtime.composeState(
							message,
							responseContent.providers,
							false,
							false,
						),
						providerStateValues,
					);
				}
			}

			// Save response memory to database.
			// - simple mode: persists after hooks in the branch below.
			// - actions mode: do NOT persist the initial LLM text here.
			//   The action callbacks produce the real user-facing messages;
			//   saving the planner text now would emit a premature reply that
			//   may be contradicted once the action completes or fails.
			// - other non-simple modes (e.g. "none"): persist immediately.
			if (
				responseMessages.length > 0 &&
				mode !== "simple" &&
				mode !== "actions"
			) {
				for (const responseMemory of responseMessages) {
					// Update the content in case inReplyTo was added
					if (responseContent) {
						responseMemory.content = responseContent;
					}
					runtime.logger.debug(
						{ src: "service:message", memoryId: responseMemory.id },
						"Saving response to memory",
					);
					await runtime.createMemory(responseMemory, "messages");

					await this.emitMessageSent(
						runtime,
						responseMemory,
						message.content.source ?? "messageHandler",
					);
				}
			}

			if (responseContent) {
				if (mode === "simple") {
					// Log provider usage for simple responses
					if (
						responseContent.providers &&
						responseContent.providers.length > 0
					) {
						runtime.logger.debug(
							{
								src: "service:message",
								providers: responseContent.providers,
							},
							"Simple response used providers",
						);
					}
					// WHY order: hooks → createMemory → deferred callback matches wire + DB.
					await runtime.applyPipelineHooks(
						"outgoing_before_deliver",
						outgoingPipelineHookContext(responseContent, {
							source: "simple",
							roomId: message.roomId,
							message,
							responseId: responseContent.responseId ?? responseMessages[0]?.id,
						}),
					);
					if (responseMessages.length > 0) {
						for (const responseMemory of responseMessages) {
							if (responseContent) {
								responseMemory.content = responseContent;
							}
							runtime.logger.debug(
								{ src: "service:message", memoryId: responseMemory.id },
								"Saving response to memory",
							);
							await runtime.createMemory(responseMemory, "messages");

							await this.emitMessageSent(
								runtime,
								responseMemory,
								message.content.source ?? "messageHandler",
							);

							if (responseMemory.id) {
								pendingSimpleMemoryIds.push(responseMemory.id);
							}
						}
					}
					pendingSimpleEmit = responseContent;
				} else if (mode === "actions") {
					// Surface the planner's text before action handlers run, so the
					// user sees the agent's plan rather than silence. The full
					// responseContent is already persisted as a memory above.
					if (
						callback &&
						!isBenchmarkMode(state) &&
						shouldEmitPlannerPreamble(runtime, responseContent)
					) {
						await callback({
							...responseContent,
							actions: [],
						});
					}

					// Pass onStreamChunk to processActions so each action can manage its own streaming context
					await runtime.processActions(
						message,
						responseMessages,
						state,
						async (content) => {
							runtime.logger.debug(
								{ src: "service:message", content },
								"Action callback",
							);
							if (responseContent) {
								responseContent.actionCallbacks = content;
							}
							if (callback) {
								return callback(content);
							}
							return [];
						},
						{ onStreamChunk: opts.onStreamChunk },
					);

					if (
						opts.continueAfterActions &&
						message.id &&
						shouldContinueAfterActions(runtime, responseContent) &&
						!suppressesPostActionContinuation(runtime, responseContent)
					) {
						const continuation = await this.runPostActionContinuation(
							runtime,
							message,
							state,
							callback,
							opts,
							runtime.getActionResults(message.id),
						);
						if (continuation.responseMessages.length > 0) {
							responseMessages = [
								...responseMessages,
								...continuation.responseMessages,
							];
						}
						if (continuation.responseContent) {
							responseContent = continuation.responseContent;
							mode = continuation.mode;
						}
						state = continuation.state;
					}
				}
			}
		} else {
			// Agent decided not to respond
			runtime.logger.debug(
				{ src: "service:message" },
				"Agent decided not to respond",
			);

			// Check if we still have the latest response ID
			const currentResponseId = agentResponses.get(message.roomId);

			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						roomId: message.roomId,
					},
					"Ignore response discarded - newer message being processed",
				);
				await this.emitRunEnded(runtime, runId, message, startTime, "replaced");
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			if (!message.id) {
				runtime.logger.error(
					{ src: "service:message", agentId: runtime.agentId },
					"Message ID is missing, cannot create ignore response",
				);
				await this.emitRunEnded(
					runtime,
					runId,
					message,
					startTime,
					"noMessageId",
				);
				return {
					didRespond: false,
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			// Construct a minimal content object indicating the terminal decision
			const terminalAction = terminalDecision ?? "IGNORE";
			const terminalContent: Content = {
				thought:
					terminalAction === "STOP"
						? "Agent decided to stop and end the run."
						: "Agent decided not to respond to this message.",
				actions: [terminalAction],
				simple: true,
				inReplyTo: createUniqueUuid(runtime, message.id),
			};

			await runtime.applyPipelineHooks(
				"outgoing_before_deliver",
				outgoingPipelineHookContext(terminalContent, {
					source: "excluded",
					roomId: message.roomId,
					message,
				}),
			);

			const terminalMemory: Memory = {
				id: asUUID(v4()),
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: terminalContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			};
			await runtime.createMemory(terminalMemory, "messages");
			await this.emitMessageSent(
				runtime,
				terminalMemory,
				message.content.source ?? "messageHandler",
			);
			runtime.logger.debug(
				{ src: "service:message", memoryId: terminalMemory.id },
				"Saved terminal response to memory",
			);

			if (callback) {
				await callback(terminalContent);
			}
		}

		// Clean up the response ID
		clearLatestResponseId(runtime.agentId, message.roomId, responseId);

		// Run evaluators before ending the turn because reflection can now mark
		// the task incomplete and trigger another continuation/action pass.
		const runEvaluate = () =>
			runtime.evaluate(
				message,
				state,
				shouldRespondToMessage && !isStopResponse(responseContent),
				async (content) => {
					runtime.logger.debug(
						{ src: "service:message", content },
						"Evaluate callback",
					);
					if (responseContent) {
						responseContent.evalCallbacks = content;
					}
					if (callback) {
						await runtime.applyPipelineHooks(
							"outgoing_before_deliver",
							outgoingPipelineHookContext(content, {
								source: "evaluate",
								roomId: message.roomId,
								message,
								responseId: content.responseId,
							}),
						);
						return callback(content);
					}
					return [];
				},
				responseMessages,
			);

		await runEvaluate();

		if (
			opts.continueAfterActions &&
			message.id &&
			!isBenchmarkMode(state)
		) {
			const taskCompletion = await runtime.getCache<TaskCompletionAssessment>(
				getTaskCompletionCacheKey(message.id),
			);
			await runtime.deleteCache(getTaskCompletionCacheKey(message.id));

			if (
				taskCompletion?.assessed &&
				!taskCompletion.completed &&
				// Honor `suppressPostActionContinuation` here too. The flag's
				// contract per Action.suppressPostActionContinuation is "stop after
				// this action — don't run any continuation LLM turn." Without this
				// guard, an action that already emitted a complete user-facing
				// reply (e.g. CALENDAR_ACTION) will get a second visible callback
				// when the reflection evaluator marks the task as incomplete and
				// triggers another LLM/processActions pass.
				!suppressesPostActionContinuation(runtime, responseContent)
			) {
				const directReplyText =
					typeof responseContent?.text === "string"
						? responseContent.text.trim()
						: "";
				let latestActionResults: ActionResult[] = [];
				const shouldWaitForUser =
					isSimpleReplyResponse(responseContent) && directReplyText.length > 0
						? isLikelyClarifyingQuestion(directReplyText)
						: (() => {
								latestActionResults = runtime.getActionResults(message.id);
								return shouldWaitForUserAfterIncompleteReflection(
									responseContent,
									latestActionResults,
								);
							})();

				if (shouldWaitForUser) {
					runtime.logger.debug(
						{
							src: "service:message",
							messageId: message.id,
							taskCompletionReason: taskCompletion.reason,
							replyPreview: getLatestVisibleReplyText(
								responseContent,
								latestActionResults,
							).slice(0, 200),
						},
						"Skipping reflection continuation because the agent is waiting for user input",
					);
				} else {
					const continuation = await this.runReflectionTaskContinuation(
						runtime,
						message,
						state,
						callback,
						opts,
						taskCompletion,
					);
					if (continuation.responseMessages.length > 0) {
						responseMessages = [
							...responseMessages,
							...continuation.responseMessages,
						];
					}
					if (continuation.responseContent) {
						responseContent = continuation.responseContent;
						mode = continuation.mode;
					}
					// Reflection produced a continuation (may or may not have
					// responseContent — e.g. actions that set results but the
					// helper returned early). Drop the deferred chatty REPLY
					// either way: emitting both would show two contradictory
					// messages, and even when responseContent is null the
					// continuation's action callbacks already went to the user.
					if (
						pendingSimpleEmit &&
						(continuation.responseContent ||
							continuation.responseMessages.length > 0)
					) {
						// Clean up orphaned memories that were persisted before
						// we knew reflection would override (Greptile P1 fix).
						for (const memId of pendingSimpleMemoryIds) {
							await runtime.deleteMemory(memId as UUID);
						}
						pendingSimpleMemoryIds = [];
						pendingSimpleEmit = null;
					}
					state = continuation.state;
				}
			}
		}

		// Flush the deferred simple-mode reply now that reflection has had its
		// chance to override. If reflection produced its own response, this is
		// already null and the original chatty REPLY is dropped.
		if (pendingSimpleEmit && callback) {
			await callback(pendingSimpleEmit);
		}

		const didRespond =
			responseMessages.length > 0 && !isStopResponse(responseContent);

		// Collect metadata for logging
		let entityName = "noname";
		if (
			message.metadata &&
			"entityName" in message.metadata &&
			typeof message.metadata.entityName === "string"
		) {
			entityName = message.metadata.entityName;
		}

		const isDM =
			message.content && message.content.channelType === ChannelType.DM;
		let roomName = entityName;

		if (!isDM) {
			const roomDatas = await runtime.getRoomsByIds([message.roomId]);
			if (roomDatas?.length) {
				const roomData = roomDatas[0];
				if (roomData.name) {
					roomName = roomData.name;
				}
				if (roomData.worldId) {
					const worldData = await runtime.getWorld(roomData.worldId);
					if (worldData) {
						roomName = `${worldData.name}-${roomName}`;
					}
				}
			}
		}

		const date = new Date();
		// Extract available actions from provider data
		const stateData = state.data;
		const stateDataProviders = stateData?.providers;
		const actionsProvider = stateDataProviders?.ACTIONS;
		const actionsProviderData = actionsProvider?.data;
		const actionsData =
			actionsProviderData && "actionsData" in actionsProviderData
				? (actionsProviderData.actionsData as Array<{ name: string }>)
				: undefined;
		const availableActions = actionsData?.map((a) => a.name) ?? [];

		const _logData = {
			at: date.toString(),
			timestamp: Math.floor(date.getTime() / 1000),
			messageId: message.id,
			userEntityId: message.entityId,
			input: message.content.text,
			thought: responseContent?.thought,
			simple: responseContent?.simple,
			availableActions,
			actions: responseContent?.actions,
			providers: responseContent?.providers,
			irt: responseContent?.inReplyTo,
			output: responseContent?.text,
			entityName,
			source: message.content.source,
			channelType: message.content.channelType,
			roomName,
		};

		// Emit run ended event
		await runtime.emitEvent(EventType.RUN_ENDED, {
			runtime,
			source: "messageHandler",
			runId,
			messageId: message.id,
			roomId: message.roomId,
			entityId: message.entityId,
			startTime,
			status: "completed",
			endTime: Date.now(),
			duration: Date.now() - startTime,
		} as RunEventPayload);

		return {
			didRespond,
			responseContent,
			responseMessages,
			state,
			mode,
			...(dualPressureLog !== null || shouldRespondClassifierAction !== null
				? {
						dualPressure: dualPressureLog,
						shouldRespondClassifierAction,
					}
				: {}),
		};
	}

	private async runNonAutonomousShouldRespondClassify(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		room: Room | undefined,
		mentionContext: MentionContext | undefined,
		opts: ResolvedMessageOptions,
		promptAttachments: GenerateTextAttachment[] | undefined,
	): Promise<{
		shouldRespondToMessage: boolean;
		terminalDecision: "IGNORE" | "STOP" | null;
		routedDecision: ContextRoutingDecision | null;
		dualPressureLog: DualPressureScores | null;
		shouldRespondClassifierAction: string | null;
		state: State;
	}> {
		let shouldRespondToMessage = true;
		let terminalDecision: "IGNORE" | "STOP" | null = null;
		let routedDecision: ContextRoutingDecision | null = null;
		let dualPressureLog: DualPressureScores | null = null;
		let shouldRespondClassifierAction: string | null = null;
		let workingState = state;

		const checkShouldRespondEnabled = runtime.isCheckShouldRespondEnabled();

		const responseDecision = this.shouldRespond(
			runtime,
			message,
			room,
			mentionContext,
		);

		runtime.logger.debug(
			{ src: "service:message", responseDecision, checkShouldRespondEnabled },
			"Response decision",
		);

		if (!checkShouldRespondEnabled) {
			runtime.logger.debug(
				{ src: "service:message" },
				"checkShouldRespond disabled, always responding (ChatGPT mode)",
			);
			shouldRespondToMessage = true;
		} else if (responseDecision.skipEvaluation) {
			runtime.logger.debug(
				{
					src: "service:message",
					agentName: runtime.character.name ?? "Agent",
					reason: responseDecision.reason,
				},
				"Skipping LLM evaluation",
			);
			routedDecision = parseContextRoutingMetadata(
				responseDecision as unknown as Record<string, unknown>,
			);
			setContextRoutingMetadata(message, routedDecision);
			shouldRespondToMessage = responseDecision.shouldRespond;
		} else {
			workingState = {
				...workingState,
				values: {
					...workingState.values,
					dualPressureThreshold: resolveDualPressureThreshold(runtime),
				},
			};
			const shouldRespondState = prepareShouldRespondState(workingState);

			const optimizedPromptService = runtime.getService<OptimizedPromptService>(
				OPTIMIZED_PROMPT_SERVICE,
			);
			const baselineShouldRespond =
				runtime.character.templates?.shouldRespondTemplate ||
				shouldRespondTemplate;
			const resolvedShouldRespondTemplate = resolveOptimizedPrompt(
				optimizedPromptService,
				"should_respond",
				baselineShouldRespond,
			);

			const _shouldRespondPrompt = composePromptFromState({
				state: shouldRespondState,
				template: resolvedShouldRespondTemplate,
			});

			runtime.logger.debug(
				{
					src: "service:message",
					agentName: runtime.character.name ?? "Agent",
					reason: responseDecision.reason,
					model: opts.shouldRespondModel,
				},
				"Using LLM evaluation",
			);

			setTrajectoryPurpose("should_respond");
			const responseObject = await runtime.dynamicPromptExecFromState({
				state: shouldRespondState,
				params: {
					prompt: resolvedShouldRespondTemplate,
					...(promptAttachments ? { attachments: promptAttachments } : {}),
				},
				schema: [
					{
						field: "name",
						description: "The name of the agent responding",
						validateField: false,
						streamField: false,
					},
					{
						field: "reasoning",
						description: "Your reasoning for this decision",
						validateField: false,
						streamField: false,
					},
					{
						field: "speak_up",
						description: "Integer 0-100 pressure TO engage",
						validateField: false,
						streamField: false,
					},
					{
						field: "hold_back",
						description: "Integer 0-100 pressure to STAY QUIET",
						validateField: false,
						streamField: false,
					},
					{
						field: "action",
						description:
							"REPLY | RESPOND | IGNORE | STOP (REPLY and RESPOND both mean engage)",
						validateField: false,
						streamField: false,
					},
					{
						field: "primaryContext",
						description:
							"Primary domain context from available_contexts (e.g., wallet, knowledge)",
						validateField: false,
						streamField: false,
					},
					{
						field: "secondaryContexts",
						description: "Optional comma-separated additional domain contexts",
						validateField: false,
						streamField: false,
					},
					{
						field: "evidenceTurnIds",
						description:
							"Optional comma-separated message IDs that influenced this decision",
						validateField: false,
						streamField: false,
					},
				],
				options: {
					contextCheckLevel: 0,
					maxRetries: Math.max(1, Math.min(opts.maxRetries, 2)),
					retryBackoff: {
						initialMs: 500,
						multiplier: 2,
						maxMs: 2000,
					},
					modelType: resolveShouldRespondModelType(opts.shouldRespondModel),
					preferredEncapsulation: "toon",
				},
			});

			runtime.logger.debug(
				{ src: "service:message", responseObject },
				"Parsed evaluation result",
			);

			const rawAction =
				typeof responseObject?.action === "string" ? responseObject.action : "";
			const actionUpper = rawAction.trim().toUpperCase();
			const hasValidClassifierAction =
				actionUpper.length > 0 && ALLOWED_CLASSIFIER_ACTIONS.has(actionUpper);
			routedDecision = parseContextRoutingMetadata(responseObject);
			setContextRoutingMetadata(message, routedDecision);
			if (!hasValidClassifierAction) {
				runtime.logger.warn(
					{
						src: "service:message",
						action: responseObject?.action,
					},
					"Classifier response missing valid action; treating as IGNORE",
				);
				terminalDecision = "IGNORE";
				shouldRespondToMessage = false;
			} else {
				const dual = applyDualPressureToClassifierAction(
					runtime,
					responseObject as Record<string, unknown> | null,
					rawAction,
				);
				dualPressureLog = dual.pressure;
				shouldRespondClassifierAction = dual.finalActionUpper;
				if (
					dual.finalActionUpper === "IGNORE" ||
					dual.finalActionUpper === "STOP"
				) {
					terminalDecision = dual.finalActionUpper as "IGNORE" | "STOP";
				}
				shouldRespondToMessage =
					dual.finalActionUpper === "REPLY" ||
					dual.finalActionUpper === "RESPOND";
			}
		}

		return {
			shouldRespondToMessage,
			terminalDecision,
			routedDecision,
			dualPressureLog,
			shouldRespondClassifierAction,
			state: workingState,
		};
	}

	/**
	 * Determines whether the agent should respond to a message.
	 * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
	 */
	shouldRespond(
		runtime: IAgentRuntime,
		message: Memory,
		room?: Room,
		mentionContext?: MentionContext,
	): ContextRoutedResponseDecision {
		if (!room) {
			return {
				shouldRespond: false,
				skipEvaluation: true,
				reason: "no room context",
			};
		}

		function normalizeEnvList(value: unknown): string[] {
			if (!value || typeof value !== "string") return [];
			const cleaned = value.trim().replace(/^\[|\]$/g, "");
			return cleaned
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
		}

		// Channel types that always trigger a response (private channels)
		const alwaysRespondChannels = [
			ChannelType.DM,
			ChannelType.VOICE_DM,
			ChannelType.SELF,
			ChannelType.API,
		];

		// Sources that always trigger a response
		const alwaysRespondSources = ["client_chat"];

		// Support runtime-configurable overrides via env settings
		const customChannels = normalizeEnvList(
			runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ??
				runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
		);
		const customSources = normalizeEnvList(
			runtime.getSetting("ALWAYS_RESPOND_SOURCES") ??
				runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"),
		);

		const respondChannels = new Set(
			[
				...alwaysRespondChannels.map((t) => t.toString()),
				...customChannels,
			].map((s: string) => s.trim().toLowerCase()),
		);

		const respondSources = [...alwaysRespondSources, ...customSources].map(
			(s: string) => s.trim().toLowerCase(),
		);

		const roomType = room.type?.toString().toLowerCase();
		const sourceStr = message.content.source?.toLowerCase() || "";
		const textMentionsAgentByName = textContainsAgentName(
			message.content.text,
			[runtime.character.name, runtime.character.username],
		);
		const textMentionsTaggedParticipants = textContainsUserTag(
			message.content.text,
		);

		// 1. DM/VOICE_DM/API channels: always respond (private channels)
		if (respondChannels.has(roomType)) {
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
		const hasPlatformMention = !!(
			mentionContext?.isMention || mentionContext?.isReply
		);
		if (hasPlatformMention) {
			const mentionType = mentionContext?.isMention ? "mention" : "reply";
			return {
				shouldRespond: true,
				skipEvaluation: true,
				reason: `platform ${mentionType}`,
			};
		}

		// 4. Mixed-address messages should still reach the agent when the text
		// explicitly names it alongside other tagged participants.
		if (textMentionsTaggedParticipants && textMentionsAgentByName) {
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
				primaryContext: "social",
				secondaryContexts: ["system"],
			};
		}

		// 6. All other cases are ambiguous enough to need the classifier.
		// Lack of a platform mention is not proof the message isn't directed
		// at the agent in a fast-moving group conversation.
		return {
			shouldRespond: false,
			skipEvaluation: false,
			reason: textMentionsAgentByName
				? "agent named in text requires LLM evaluation"
				: "needs LLM evaluation",
			primaryContext: "general",
		};
	}

	/**
	 * Processes attachments by generating descriptions for supported media types.
	 */
	async processAttachments(
		runtime: IAgentRuntime,
		attachments: Media[],
	): Promise<Media[]> {
		if (!attachments || attachments.length === 0) {
			return [];
		}
		runtime.logger.debug(
			{ src: "service:message", count: attachments.length },
			"Processing attachments",
		);

		const processedAttachments = await Promise.all(
			attachments.map(async (attachment) => {
				const processedAttachment: Media = { ...attachment };

				const isRemote = /^(http|https):\/\//.test(attachment.url);
				const url = isRemote
					? attachment.url
					: getLocalServerUrl(attachment.url);

				// Only process images that don't already have descriptions
				if (
					attachment.contentType === ContentType.IMAGE &&
					!attachment.description
				) {
					// Skip image analysis when vision / image-description is explicitly
					// disabled (e.g. the user toggled the Vision capability off).
					const disableImageDesc = runtime.getSetting(
						"DISABLE_IMAGE_DESCRIPTION",
					);
					if (disableImageDesc === true || disableImageDesc === "true") {
						return processedAttachment;
					}

					runtime.logger.debug(
						{ src: "service:message", imageUrl: attachment.url },
						"Generating image description",
					);

					let imageUrl = url;
					const runtimeFetch = runtime.fetch ?? globalThis.fetch;
					const inlineData = attachment as MediaWithInlineData;

					if (
						typeof inlineData._data === "string" &&
						inlineData._data.trim() &&
						typeof inlineData._mimeType === "string" &&
						inlineData._mimeType.trim()
					) {
						imageUrl = `data:${inlineData._mimeType};base64,${inlineData._data}`;
					} else if (!isRemote) {
						// Convert local/internal media to base64
						const res = await runtimeFetch(url);
						if (!res.ok)
							throw new Error(`Failed to fetch image: ${res.statusText}`);

						const arrayBuffer = await res.arrayBuffer();
						const buffer = Buffer.from(arrayBuffer);
						const contentType =
							res.headers.get("content-type") || "application/octet-stream";
						imageUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
					}

					const optimizedMediaService =
						runtime.getService<OptimizedPromptService>(OPTIMIZED_PROMPT_SERVICE);
					const resolvedImagePrompt = resolveOptimizedPrompt(
						optimizedMediaService,
						"media_description",
						imageDescriptionTemplate,
					);
					const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
						prompt: resolvedImagePrompt,
						imageUrl,
					});

					if (typeof response === "string") {
						const parsedXml = parseKeyValueXml(response);

						if (parsedXml && (parsedXml.description || parsedXml.text)) {
							processedAttachment.description =
								(typeof parsedXml.description === "string"
									? parsedXml.description
									: "") || "";
							processedAttachment.title =
								(typeof parsedXml.title === "string"
									? parsedXml.title
									: "Image") || "Image";
							processedAttachment.text =
								(typeof parsedXml.text === "string" ? parsedXml.text : "") ||
								(typeof parsedXml.description === "string"
									? parsedXml.description
									: "") ||
								"";

							runtime.logger.debug(
								{
									src: "service:message",
									descriptionPreview:
										processedAttachment.description?.substring(0, 100),
								},
								"Generated image description",
							);
						} else {
							// Fallback: Try simple regex parsing
							const responseStr = response as string;
							const titleMatch = responseStr.match(/<title>([^<]+)<\/title>/);
							const descMatch = responseStr.match(
								/<description>([^<]+)<\/description>/,
							);
							const textMatch = responseStr.match(/<text>([^<]+)<\/text>/);

							if (titleMatch || descMatch || textMatch) {
								processedAttachment.title = titleMatch?.[1] || "Image";
								processedAttachment.description = descMatch?.[1] || "";
								processedAttachment.text =
									textMatch?.[1] || descMatch?.[1] || "";

								runtime.logger.debug(
									{
										src: "service:message",
										descriptionPreview:
											processedAttachment.description?.substring(0, 100),
									},
									"Used fallback XML parsing for description",
								);
							} else {
								runtime.logger.warn(
									{ src: "service:message" },
									"Failed to parse XML response for image description",
								);
							}
						}
					} else if (
						response &&
						typeof response === "object" &&
						"description" in response
					) {
						// Handle object responses for backwards compatibility
						const objResponse = response as ImageDescriptionResponse;
						processedAttachment.description = objResponse.description;
						processedAttachment.title = objResponse.title || "Image";
						processedAttachment.text = objResponse.description;

						runtime.logger.debug(
							{
								src: "service:message",
								descriptionPreview: processedAttachment.description?.substring(
									0,
									100,
								),
							},
							"Generated image description",
						);
					} else {
						runtime.logger.warn(
							{ src: "service:message" },
							"Unexpected response format for image description",
						);
					}
				} else if (
					attachment.contentType === ContentType.DOCUMENT &&
					!attachment.text
				) {
					const docFetch = runtime.fetch ?? globalThis.fetch;
					const res = await docFetch(url);
					if (!res.ok)
						throw new Error(`Failed to fetch document: ${res.statusText}`);

					const contentType = res.headers.get("content-type") || "";
					const isPlainText = contentType.startsWith("text/plain");

					if (isPlainText) {
						runtime.logger.debug(
							{ src: "service:message", documentUrl: attachment.url },
							"Processing plain text document",
						);

						const textContent = await res.text();
						processedAttachment.text = textContent;
						processedAttachment.title =
							processedAttachment.title || "Text File";

						runtime.logger.debug(
							{
								src: "service:message",
								textPreview: processedAttachment.text?.substring(0, 100),
							},
							"Extracted text content",
						);
					} else {
						runtime.logger.warn(
							{ src: "service:message", contentType },
							"Skipping non-plain-text document",
						);
					}
				} else if (
					attachment.contentType === ContentType.AUDIO &&
					!attachment.text
				) {
					runtime.logger.debug(
						{ src: "service:message", audioUrl: attachment.url },
						"Transcribing audio attachment",
					);

					try {
						let transcriptionInput: string | Buffer = url;
						const audioFetch = runtime.fetch ?? globalThis.fetch;

						// For local/internal URLs, fetch the audio as a buffer
						if (!isRemote) {
							const res = await audioFetch(url);
							if (!res.ok)
								throw new Error(`Failed to fetch audio: ${res.statusText}`);
							const arrayBuffer = await res.arrayBuffer();
							transcriptionInput = Buffer.from(arrayBuffer);
						}

						const transcript = await runtime.useModel(
							ModelType.TRANSCRIPTION,
							transcriptionInput,
						);

						if (typeof transcript === "string" && transcript.trim()) {
							processedAttachment.text = transcript.trim();
							processedAttachment.title = processedAttachment.title || "Audio";
							processedAttachment.description = `Transcript: ${transcript.trim()}`;

							runtime.logger.debug(
								{
									src: "service:message",
									transcriptPreview: processedAttachment.text?.substring(
										0,
										100,
									),
								},
								"Transcribed audio attachment",
							);
						}
					} catch (err) {
						runtime.logger.warn(
							{ src: "service:message", err },
							"Audio transcription failed, continuing without transcript",
						);
					}
				} else if (
					attachment.contentType === ContentType.VIDEO &&
					!attachment.text
				) {
					runtime.logger.debug(
						{ src: "service:message", videoUrl: attachment.url },
						"Transcribing video attachment",
					);

					try {
						let transcriptionInput: string | Buffer = url;
						const videoFetch = runtime.fetch ?? globalThis.fetch;

						// For local/internal URLs, fetch the video as a buffer
						if (!isRemote) {
							const res = await videoFetch(url);
							if (!res.ok)
								throw new Error(`Failed to fetch video: ${res.statusText}`);
							const arrayBuffer = await res.arrayBuffer();
							transcriptionInput = Buffer.from(arrayBuffer);
						}

						const transcript = await runtime.useModel(
							ModelType.TRANSCRIPTION,
							transcriptionInput,
						);

						if (typeof transcript === "string" && transcript.trim()) {
							processedAttachment.text = transcript.trim();
							processedAttachment.title = processedAttachment.title || "Video";
							processedAttachment.description = `Transcript: ${transcript.trim()}`;

							runtime.logger.debug(
								{
									src: "service:message",
									transcriptPreview: processedAttachment.text?.substring(
										0,
										100,
									),
								},
								"Transcribed video attachment",
							);
						}
					} catch (err) {
						runtime.logger.warn(
							{ src: "service:message", err },
							"Video transcription failed, continuing without transcript",
						);
					}
				}

				return processedAttachment;
			}),
		);

		return processedAttachments;
	}

	private async runPostActionContinuation(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		callback: HandlerCallback | undefined,
		opts: ResolvedMessageOptions,
		initialActionResults: ActionResult[],
	): Promise<StrategyResult> {
		const contextRoutingStateValues = {
			[AVAILABLE_CONTEXTS_STATE_KEY]:
				state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
			[CONTEXT_ROUTING_STATE_KEY]: state.values?.[CONTEXT_ROUTING_STATE_KEY],
		};
		const taskCompletion = state.data?.taskCompletion as
			| TaskCompletionAssessment
			| undefined;

		if (!message.id || initialActionResults.length === 0) {
			return {
				responseContent: null,
				responseMessages: [],
				state,
				mode: "none",
			};
		}

		const traceActionResults: ActionResult[] = [...initialActionResults];
		const responseMessages: Memory[] = [];
		let accumulatedState = state;
		let responseContent: Content | null = null;

		for (
			let iterationCount = 0;
			iterationCount < opts.maxMultiStepIterations;
			iterationCount++
		) {
			accumulatedState = withTaskCompletion(
				withActionResults(
					await composeContinuationDecisionState(
						runtime,
						message,
						contextRoutingStateValues,
					),
					traceActionResults,
				),
				taskCompletion,
			);

			const continuation = await this.runSingleShotCore(
				runtime,
				message,
				accumulatedState,
				opts,
				asUUID(v4()),
				resolvePromptAttachments(message.content.attachments),
				{
					prompt:
						runtime.character.templates?.postActionDecisionTemplate ||
						postActionDecisionTemplate,
					precomposedState: accumulatedState,
					failureStage: "preparing the follow-up reply after actions",
				},
			);

			if (!continuation.responseContent) {
				runtime.logger.debug(
					{ src: "service:message", iteration: iterationCount + 1 },
					"Post-action continuation produced no response",
				);
				break;
			}

			responseContent = continuation.responseContent;
			if (message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			if (responseContent.providers && responseContent.providers.length > 0) {
				accumulatedState = withActionResults(
					withContextRoutingValues(
						await composeProviderGroundedResponseState(
							runtime,
							message,
							responseContent.providers,
						),
						contextRoutingStateValues,
					),
					traceActionResults,
				);
			} else {
				accumulatedState = withActionResults(
					continuation.state,
					traceActionResults,
				);
			}
			accumulatedState = withTaskCompletion(accumulatedState, taskCompletion);

			if (
				continuation.responseMessages.length > 0 &&
				continuation.mode !== "simple"
			) {
				for (const responseMemory of continuation.responseMessages) {
					responseMemory.content = responseContent;
					await runtime.createMemory(responseMemory, "messages");
					await this.emitMessageSent(
						runtime,
						responseMemory,
						message.content.source ?? "messageHandler",
					);
				}
				responseMessages.push(...continuation.responseMessages);
			}

			if (continuation.mode === "simple") {
				await runtime.applyPipelineHooks(
					"outgoing_before_deliver",
					outgoingPipelineHookContext(responseContent, {
						source: "continuation_simple",
						roomId: message.roomId,
						message,
						responseId:
							responseContent.responseId ??
							continuation.responseMessages[0]?.id,
					}),
				);
				if (continuation.responseMessages.length > 0) {
					for (const responseMemory of continuation.responseMessages) {
						responseMemory.content = responseContent;
						await runtime.createMemory(responseMemory, "messages");
						await this.emitMessageSent(
							runtime,
							responseMemory,
							message.content.source ?? "messageHandler",
						);
					}
					responseMessages.push(...continuation.responseMessages);
				}
				if (callback) {
					await callback(responseContent);
				}
				break;
			}

			if (continuation.mode !== "actions") {
				break;
			}

			await runtime.processActions(
				message,
				continuation.responseMessages,
				accumulatedState,
				async (content) => {
					runtime.logger.debug(
						{ src: "service:message", content },
						"Post-action callback",
					);
					if (responseContent) {
						responseContent.actionCallbacks = content;
					}
					if (callback) {
						return callback(content);
					}
					return [];
				},
				{ onStreamChunk: opts.onStreamChunk },
			);

			if (
				!shouldContinueAfterActions(runtime, responseContent) ||
				suppressesPostActionContinuation(runtime, responseContent)
			) {
				break;
			}

			const latestActionResults = runtime.getActionResults(message.id);
			if (latestActionResults.length === 0) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount + 1 },
					"Post-action continuation produced no new action results",
				);
				break;
			}
			traceActionResults.push(...latestActionResults);
		}

		accumulatedState = withTaskCompletion(
			withActionResults(accumulatedState, traceActionResults),
			taskCompletion,
		);

		return {
			responseContent,
			responseMessages,
			state: accumulatedState,
			mode: responseContent ? "simple" : "none",
		};
	}

	private async runReflectionTaskContinuation(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		callback: HandlerCallback | undefined,
		opts: ResolvedMessageOptions,
		taskCompletion: TaskCompletionAssessment,
	): Promise<StrategyResult> {
		const contextRoutingStateValues = {
			[AVAILABLE_CONTEXTS_STATE_KEY]:
				state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
			[CONTEXT_ROUTING_STATE_KEY]: state.values?.[CONTEXT_ROUTING_STATE_KEY],
		};
		const initialActionResults = message.id
			? runtime.getActionResults(message.id)
			: [];
		let accumulatedState = withTaskCompletion(
			withActionResults(
				await composeContinuationDecisionState(
					runtime,
					message,
					contextRoutingStateValues,
				),
				initialActionResults,
			),
			taskCompletion,
		);
		const continuation = await this.runSingleShotCore(
			runtime,
			message,
			accumulatedState,
			opts,
			asUUID(v4()),
			resolvePromptAttachments(message.content.attachments),
			{
				prompt:
					runtime.character.templates?.postActionDecisionTemplate ||
					postActionDecisionTemplate,
				precomposedState: accumulatedState,
				failureStage: "continuing after reflection marked the task incomplete",
			},
		);

		if (!continuation.responseContent) {
			return {
				responseContent: null,
				responseMessages: [],
				state: accumulatedState,
				mode: "none",
			};
		}

		const responseMessages: Memory[] = [];
		const responseContent = continuation.responseContent;
		if (message.id) {
			responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
		}

		if (responseContent.providers && responseContent.providers.length > 0) {
			accumulatedState = withTaskCompletion(
				withActionResults(
					withContextRoutingValues(
						await composeProviderGroundedResponseState(
							runtime,
							message,
							responseContent.providers,
						),
						contextRoutingStateValues,
					),
					initialActionResults,
				),
				taskCompletion,
			);
		} else {
			accumulatedState = withTaskCompletion(
				withActionResults(continuation.state, initialActionResults),
				taskCompletion,
			);
		}

		if (
			continuation.responseMessages.length > 0 &&
			continuation.mode !== "simple"
		) {
			for (const responseMemory of continuation.responseMessages) {
				responseMemory.content = responseContent;
				await runtime.createMemory(responseMemory, "messages");
				await this.emitMessageSent(
					runtime,
					responseMemory,
					message.content.source ?? "messageHandler",
				);
			}
			responseMessages.push(...continuation.responseMessages);
		}

		if (continuation.mode === "simple") {
			await runtime.applyPipelineHooks(
				"outgoing_before_deliver",
				outgoingPipelineHookContext(responseContent, {
					source: "continuation_simple",
					roomId: message.roomId,
					message,
					responseId:
						responseContent.responseId ?? continuation.responseMessages[0]?.id,
				}),
			);
			if (continuation.responseMessages.length > 0) {
				for (const responseMemory of continuation.responseMessages) {
					responseMemory.content = responseContent;
					await runtime.createMemory(responseMemory, "messages");
					await this.emitMessageSent(
						runtime,
						responseMemory,
						message.content.source ?? "messageHandler",
					);
				}
				responseMessages.push(...continuation.responseMessages);
			}
			if (callback) {
				await callback(responseContent);
			}

			return {
				responseContent,
				responseMessages,
				state: accumulatedState,
				mode: "simple",
			};
		}

		if (continuation.mode !== "actions") {
			return {
				responseContent,
				responseMessages,
				state: accumulatedState,
				mode: continuation.mode,
			};
		}

		await runtime.processActions(
			message,
			continuation.responseMessages,
			accumulatedState,
			async (content) => {
				runtime.logger.debug(
					{ src: "service:message", content },
					"Reflection continuation callback",
				);
				responseContent.actionCallbacks = content;
				if (callback) {
					return callback(content);
				}
				return [];
			},
			{ onStreamChunk: opts.onStreamChunk },
		);

		const latestActionResults = message.id
			? runtime.getActionResults(message.id)
			: [];
		accumulatedState = withTaskCompletion(
			withActionResults(
				accumulatedState,
				latestActionResults.length > 0
					? latestActionResults
					: initialActionResults,
			),
			taskCompletion,
		);

		if (
			latestActionResults.length > 0 &&
			shouldContinueAfterActions(runtime, responseContent) &&
			!suppressesPostActionContinuation(runtime, responseContent)
		) {
			return await this.runPostActionContinuation(
				runtime,
				message,
				accumulatedState,
				callback,
				opts,
				latestActionResults,
			);
		}

		return {
			responseContent,
			responseMessages,
			state: accumulatedState,
			mode: "actions",
		};
	}

	/**
	 * Single-shot strategy: one LLM call to generate response
	 * Uses dynamicPromptExecFromState for validation-aware structured output
	 */
	private async runSingleShotCore(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		opts: ResolvedMessageOptions,
		responseId: UUID,
		promptAttachments?: GenerateTextAttachment[],
		overrides?: {
			prompt?: string;
			precomposedState?: State;
			failureStage?: string;
			providerFollowup?: boolean;
		},
	): Promise<StrategyResult> {
		state =
			overrides?.precomposedState ??
			(await composeStructuredResponseState(runtime, message));

		if (!state.values?.actionNames) {
			runtime.logger.warn(
				{ src: "service:message" },
				"actionNames data missing from state",
			);
		}

		let responseContent: Content | null = null;

		// Create streaming context for retry state tracking
		const streamingExtractor = opts.onStreamChunk
			? new MarkableExtractor()
			: undefined;
		const streamingCtx =
			streamingExtractor && opts.onStreamChunk
				? createStreamingContext(
						streamingExtractor,
						opts.onStreamChunk,
						responseId,
					)
				: undefined;

		// Resolve the template prompt once so it's available for both the primary
		// call and any follow-up repair prompts (e.g. parameter repair).
		const optimizedResponseService =
			runtime.getService<OptimizedPromptService>(OPTIMIZED_PROMPT_SERVICE);
		const baselineResponseTemplate =
			runtime.character.templates?.messageHandlerTemplate ||
			messageHandlerTemplate;
		let prompt =
			overrides?.prompt ||
			resolveOptimizedPrompt(
				optimizedResponseService,
				"response",
				baselineResponseTemplate,
			);
		if (overrides?.providerFollowup) {
			prompt = buildProviderFollowupPrompt(prompt);
		}

		// Use dynamicPromptExecFromState for structured output with validation
		setTrajectoryPurpose("response");
		const parsedXml = await runtime.dynamicPromptExecFromState({
			state,
			params: {
				prompt,
				...(promptAttachments ? { attachments: promptAttachments } : {}),
			},
			schema: [
				// WHY validateField: false on non-streamed fields?
				// At validation level 1, each field gets validation codes by default.
				// If a non-streamed field's code is corrupted, we'd retry unnecessarily.
				// By opting out, we reduce token overhead AND avoid false failures.
				{
					field: "thought",
					description:
						"Your internal reasoning about the message and what to do",
					validateField: false,
					streamField: false,
				},
				{
					field: "actions",
					description:
						"Ordered action entries. For XML, use one or more <action><name>ACTION_NAME</name><params>...</params></action> blocks inside <actions>.",
					required: false,
					validateField: false,
					streamField: false,
				},
				{
					field: "providers",
					description:
						"Optional provider names to call before the final reply or action. Use an empty field when no provider lookup is needed.",
					required: false,
					validateField: false,
					streamField: false,
				},
				// WHY streamField: true? This is the user-facing output - stream it!
				// WHY validateField default? At level 1, we want to validate text integrity
				{
					field: "text",
					description: "The text response to send to the user",
					streamField: true,
				},
				{
					field: "simple",
					description: "Whether this is a simple response (true/false)",
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.ACTION_PLANNER,
				preferredEncapsulation: "xml",
				maxRetries: opts.maxRetries,
				// Stream through the filtered context callback for real-time output
				onStreamChunk: streamingCtx?.onStreamChunk,
			},
		});

		runtime.logger.debug(
			{ src: "service:message", parsedXml },
			"Parsed Response Content",
		);

		if (parsedXml) {
			// Mark streaming as complete now that we have a valid response
			streamingExtractor?.markComplete();
			const rawPlannerActions = extractPlannerActionNames(
				parsedXml as Record<string, unknown>,
			);
			let finalActions = normalizePlannerActions(
				parsedXml as Record<string, unknown>,
				runtime,
			);
			let normalizedProviders = normalizePlannerProviders(
				parsedXml as Record<string, unknown>,
				runtime,
			);

			if (
				shouldAttemptCanonicalActionRepair(rawPlannerActions, finalActions)
			) {
				const repairedPlannerOutput = await repairCanonicalPlannerActions({
					runtime,
					message,
					rawPlannerActions,
					rawPlannerProviders: normalizedProviders,
					plannerReplyText: String(parsedXml.text || ""),
				});
				if (repairedPlannerOutput) {
					const repairedActions = normalizePlannerActions(
						repairedPlannerOutput,
						runtime,
					);
					const hasRecoveredOperationalAction = repairedActions.some(
						(actionName) =>
							!ACTION_REPAIR_PASSIVE_ACTIONS.has(
								normalizeActionIdentifier(actionName),
							),
					);
					if (hasRecoveredOperationalAction) {
						finalActions = repairedActions;
						normalizedProviders = normalizePlannerProviders(
							repairedPlannerOutput,
							runtime,
						);
						if (repairedPlannerOutput.params) {
							parsedXml.params = repairedPlannerOutput.params;
						}
					}
				}
			}

			responseContent = {
				...parsedXml,
				thought: String(parsedXml.thought || ""),
				actions: finalActions,
				providers: normalizedProviders,
				text: String(parsedXml.text || ""),
				simple: parsedXml.simple === true || parsedXml.simple === "true",
			};
		} else {
			// dynamicPromptExecFromState returned null - use streamed text if available
			const streamedText = streamingCtx?.getStreamedText?.() || "";
			const isTextComplete = streamingCtx?.isComplete?.() ?? false;

			if (isTextComplete && streamedText) {
				runtime.logger.info(
					{
						src: "service:message",
						streamedTextLength: streamedText.length,
						streamedTextPreview: streamedText.substring(0, 100),
					},
					"Text extraction complete - using streamed text",
				);

				responseContent = {
					thought: "Response generated via streaming",
					actions: ["REPLY"],
					providers: [],
					text: streamedText,
					simple: true,
				};
			} else if (streamedText && !isTextComplete) {
				// Text was cut mid-stream - attempt continuation
				runtime.logger.debug(
					{
						src: "service:message",
						streamedTextLength: streamedText.length,
						streamedTextPreview: streamedText.substring(0, 100),
					},
					"Text cut mid-stream - attempting continuation",
				);

				// Reset extractor for fresh streaming of continuation
				streamingCtx?.reset?.();

				// Build continuation prompt with full context (reuses `prompt` from outer scope)
				const escapedStreamedText = escapeHandlebars(streamedText);
				const continuationPrompt = `${prompt}

[CONTINUATION REQUIRED]
Your previous response was cut off. The user already received this text:
"${escapedStreamedText}"

Continue EXACTLY from where you left off. Do NOT repeat what was already said.
Output ONLY the continuation, starting immediately after the last character above.`;

				const continuationParsed = await runtime.dynamicPromptExecFromState({
					state,
					params: {
						prompt: continuationPrompt,
						...(promptAttachments ? { attachments: promptAttachments } : {}),
					},
					schema: [
						{
							field: "text",
							description: "Continuation of response",
							required: true,
							streamField: true,
						},
					],
					options: {
						modelType: ModelType.ACTION_PLANNER,
						preferredEncapsulation: "xml",
						contextCheckLevel: 0, // Fast mode for continuations - we trust the model
						onStreamChunk: streamingCtx?.onStreamChunk,
					},
				});

				const continuationText = String(continuationParsed?.text || "");
				const fullText = streamedText + continuationText;

				responseContent = {
					thought: "Response completed via continuation",
					actions: ["REPLY"],
					providers: [],
					text: fullText,
					simple: true,
				};
			} else {
				runtime.logger.warn(
					{ src: "service:message" },
					"dynamicPromptExecFromState returned null",
				);
				const groundedFallback = await this.tryGroundedFallbackReply(
					runtime,
					message,
					state,
					responseId,
					promptAttachments,
				);
				if (groundedFallback) {
					return groundedFallback;
				}
				return await this.buildStructuredFailureReply(
					runtime,
					message,
					state,
					responseId,
					overrides?.failureStage ?? "preparing the reply",
				);
			}
		}

			if (!responseContent) {
				return {
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			if (
				!overrides?.providerFollowup &&
				shouldAttemptProviderRescue(responseContent)
			) {
				const rescuedProviders = await recoverProvidersForTurn({
					runtime,
					state,
					draftReply: String(responseContent.text || ""),
					attachments: promptAttachments,
				});
				if (rescuedProviders.length > 0) {
					runtime.logger.info(
						{
							src: "service:message",
							rescuedProviders,
							originalActions: responseContent.actions ?? [],
						},
						"Selected providers during reply rescue pass",
					);
					responseContent.providers = rescuedProviders;
				}
			}

			// Action parameter repair (Python parity):
		// If the model selected actions with required parameters but omitted <params>,
		// do a second pass asking for ONLY a <params> block.
		const requiredByAction = new Map<string, string[]>();
		const actionByName = new Map<string, Action>();
		for (const action of runtime.actions) {
			const normalizedName = action.name.trim().toUpperCase();
			if (normalizedName) {
				actionByName.set(normalizedName, action);
			}
		}
		for (const a of responseContent.actions ?? []) {
			const actionName = typeof a === "string" ? a.trim().toUpperCase() : "";
			if (!actionName) continue;
			const actionDef = actionByName.get(actionName);
			const required =
				actionDef?.parameters?.filter((p) => p.required).map((p) => p.name) ??
				[];
			if (required.length > 0) {
				requiredByAction.set(actionName, required);
			}
		}

		const existingParams = parseActionParams(responseContent.params);

		const missingRequiredParams = (): boolean => {
			for (const [actionName, required] of requiredByAction) {
				const params = existingParams.get(actionName);
				if (!params) return true;
				for (const key of required) {
					if (!(key in params)) return true;
				}
			}
			return false;
		};

		if (requiredByAction.size > 0 && missingRequiredParams()) {
			const requirementLines = Array.from(requiredByAction.entries())
				.map(([a, req]) => `- ${a}: ${req.join(", ")}`)
				.join("\n");
			const repairPrompt = [
				prompt,
				"",
				"# Parameter Repair",
				"You selected actions that require parameters but did not include a complete params object.",
				"Return ONLY XML with a top-level <params> field.",
				"Example:",
				"<response>",
				"  <params>",
				"    <SEND_MESSAGE>",
				"      <target>room-or-channel-id</target>",
				"      <text>message body</text>",
				"    </SEND_MESSAGE>",
				"  </params>",
				"</response>",
				"",
				"Required parameters by action:",
				requirementLines,
				"",
				"Do not include thought, actions, providers, text, or any other fields.",
			].join("\n");

			const repairResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: repairPrompt,
			});
			const repairParsed =
				parseKeyValueXml<Record<string, unknown>>(repairResponse);
			if (repairParsed?.params) {
				responseContent.params = repairParsed.params as Content["params"];
			}
		}

			const benchmarkMode = isBenchmarkMode(state);

			// Benchmark mode (Python parity): force action-based loop when benchmark context is present.
			if (benchmarkMode) {
			if (!responseContent.actions || responseContent.actions.length === 0) {
				responseContent.actions = ["REPLY"];
			}
			if (
				!responseContent.providers ||
				responseContent.providers.length === 0
			) {
				responseContent.providers = ["CONTEXT_BENCH"];
			}
			// Suppress any direct planner answer; the REPLY action should generate final output.
			if (responseContent.actions.some((a) => a.toUpperCase() === "REPLY")) {
				responseContent.text = "";
			}
		}

		// LLM terminal-control ambiguity handling
		if (responseContent.actions && responseContent.actions.length > 1) {
			const isIgnore = (a: unknown) =>
				typeof a === "string" && a.toUpperCase() === "IGNORE";
			const isStop = (a: unknown) =>
				typeof a === "string" && a.toUpperCase() === "STOP";
			const hasIgnore = responseContent.actions.some(isIgnore);
			const hasStop = responseContent.actions.some(isStop);

			if (hasIgnore) {
				if (!responseContent.text || responseContent.text.trim() === "") {
					responseContent.actions = ["IGNORE"];
				} else {
					const filtered = responseContent.actions.filter((a) => !isIgnore(a));
					responseContent.actions = filtered.length ? filtered : ["REPLY"];
				}
			}

			if (hasStop) {
				const filtered = responseContent.actions.filter((a) => !isStop(a));
				responseContent.actions = filtered.length ? filtered : ["STOP"];
			}
		}

		// Automatically determine if response is simple
		const isSimple = isSimpleReplyResponse(responseContent);
		const isStop = isStopResponse(responseContent);

		responseContent.simple = isSimple;
		// Include message ID for streaming coordination (so broadcast uses same ID)
		responseContent.responseId = responseId;

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

			return {
				responseContent,
				responseMessages,
				state,
				mode: isStop
					? "none"
					: isSimple && responseContent.text
						? "simple"
						: "actions",
			};
		}

	private async tryGroundedFallbackReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		promptAttachments?: GenerateTextAttachment[],
	): Promise<StrategyResult | null> {
		let groundedState = state;
		const selectedProviders = await recoverProvidersForTurn({
			runtime,
			state,
			attachments: promptAttachments,
		});

		if (selectedProviders.length > 0) {
			groundedState = await composeFocusedProviderReplyState(
				runtime,
				message,
				selectedProviders,
			);
		}

		const prompt = composePromptFromState({
			state: groundedState,
			template: buildGroundedFallbackReplyPrompt(),
		});

		try {
			const result = await runtime.useModel(ModelType.TEXT_SMALL, {
				prompt,
				...(promptAttachments ? { attachments: promptAttachments } : {}),
			});
			const text = typeof result === "string" ? result.trim() : "";
			if (!text) {
				return null;
			}

			const responseContent: Content = {
				thought:
					selectedProviders.length > 0
						? "Grounded fallback reply from selected providers"
						: "Grounded fallback reply",
				actions: ["REPLY"],
				providers: selectedProviders,
				text,
				simple: true,
				responseId,
			};
			const responseMessages: Memory[] = [
				{
					id: responseId,
					entityId: runtime.agentId,
					agentId: runtime.agentId,
					content: responseContent,
					roomId: message.roomId,
					createdAt: Date.now(),
				},
			];

			return {
				responseContent,
				responseMessages,
				state: groundedState,
				mode: "simple",
			};
		} catch (error) {
			runtime.logger.warn(
				{
					src: "service:message",
					error: error instanceof Error ? error.message : String(error),
				},
				"Grounded fallback reply generation failed",
			);
			return null;
		}
	}

	private async buildStructuredFailureReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): Promise<StrategyResult> {
		const failure = getStructuredOutputFailure(state);
		const recentMessages =
			typeof state.values?.recentMessages === "string" &&
			state.values.recentMessages.trim().length > 0
				? state.values.recentMessages
				: typeof state.text === "string" && state.text.trim().length > 0
					? state.text
					: typeof message.content.text === "string"
						? message.content.text
						: "(unavailable)";
		const actionResults = Array.isArray(state.data?.actionResults)
			? state.data.actionResults
			: [];
		const failurePrompt = [
			"You are recovering from an internal structured-output failure while responding to a user.",
			"Write the next user-facing reply in plain language.",
			"",
			"Rules:",
			"- Explain what failed and why using only the diagnostics below.",
			"- Mention any completed or failed actions if action results are available.",
			"- Be transparent, concise, and avoid inventing causes.",
			"- If the model returned malformed XML, TOON, or JSON, say that clearly.",
			"- Suggest the most useful next step for the user.",
			"- Return only the reply text. No XML, JSON, TOON, bullet labels, or <think>.",
			"",
			`Failure Stage: ${stage}`,
			"",
			"Structured Failure Diagnostics:",
			summarizeStructuredOutputFailure(failure),
			"",
			"Recent Conversation:",
			recentMessages,
			"",
			"Action Results So Far:",
			typeof state.values?.actionResults === "string" &&
			state.values.actionResults.trim().length > 0
				? state.values.actionResults
				: "No action results available.",
			"",
			"Reply:",
		].join("\n");

		let replyText = "";
		for (const modelType of [
			ModelType.TEXT_LARGE,
			ModelType.RESPONSE_HANDLER,
			ModelType.TEXT_SMALL,
			ModelType.TEXT_NANO,
		] as const) {
			try {
				const response = await runtime.useModel(modelType, {
					prompt: failurePrompt,
				});
				if (typeof response !== "string") {
					continue;
				}

				const cleaned = response
					.replace(/<think>[\s\S]*?<\/think>/g, "")
					.trim();
				const looksStructuredReply =
					cleaned.startsWith("<") ||
					/^TOON\b/i.test(cleaned) ||
					/^(thought|text)\s*:/i.test(cleaned);
				const parsed = looksStructuredReply
					? parseKeyValueXml<{ text?: string }>(cleaned)
					: null;
				replyText =
					typeof parsed?.text === "string" && parsed.text.trim().length > 0
						? parsed.text.trim()
						: cleaned;
				if (replyText) {
					break;
				}
			} catch (error) {
				runtime.logger.warn(
					{
						src: "service:message",
						stage,
						modelType,
						error: error instanceof Error ? error.message : String(error),
					},
					"Structured failure reply generation failed for model",
				);
			}
		}

		if (!replyText) {
			const failureReason =
				failure?.parseError ??
				failure?.issues?.[0] ??
				"the model returned output that did not match the required format";
			replyText = [
				`I hit an internal parsing error while ${stage}.`,
				`Reason: ${failureReason}.`,
				summarizeActionResultsForUser(actionResults),
				"Please try again or ask me to retry the last step.",
			]
				.filter(Boolean)
				.join(" ");
		}

		replyText = truncateToCompleteSentence(replyText.trim(), 2000);

		const responseContent: Content = {
			thought: `Explain the structured-output failure during ${stage}.`,
			actions: ["REPLY"],
			providers: [],
			text: replyText,
			simple: true,
			responseId,
		};

		const responseMessages: Memory[] = [
			{
				id: responseId,
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				content: responseContent,
				roomId: message.roomId,
				createdAt: Date.now(),
			},
		];

		return {
			responseContent,
			responseMessages,
			state,
			mode: "simple",
		};
	}

	/**
	 * Multi-step strategy: iterative action execution with final summary
	 */
	private async runMultiStepCore(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		callback: HandlerCallback | undefined,
		opts: ResolvedMessageOptions,
		responseId: UUID,
		promptAttachments?: GenerateTextAttachment[],
		overrides?: {
			precomposedState?: State;
		},
	): Promise<StrategyResult> {
		const contextRoutingStateValues = {
			[AVAILABLE_CONTEXTS_STATE_KEY]:
				overrides?.precomposedState?.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
			[CONTEXT_ROUTING_STATE_KEY]:
				overrides?.precomposedState?.values?.[CONTEXT_ROUTING_STATE_KEY],
		};

		const traceActionResult: MultiStepActionResult[] = [];
		let accumulatedState: MultiStepState = state as MultiStepState;
		let iterationCount = 0;

		while (iterationCount < opts.maxMultiStepIterations) {
			iterationCount++;
			runtime.logger.debug(
				{
					src: "service:message",
					iteration: iterationCount,
					maxIterations: opts.maxMultiStepIterations,
				},
				"Starting multi-step iteration",
			);

			accumulatedState = withContextRoutingValues(
				(await runtime.composeState(
					message,
					["RECENT_MESSAGES", "ACTION_STATE", "PROVIDERS"],
					false,
					false,
				)) as MultiStepState,
				contextRoutingStateValues,
			) as MultiStepState;
			accumulatedState.data.actionResults = traceActionResult;

			// Use dynamicPromptExecFromState for structured decision output
			const optimizedPlannerService =
				runtime.getService<OptimizedPromptService>(OPTIMIZED_PROMPT_SERVICE);
			const baselinePlannerTemplate =
				runtime.character.templates?.multiStepDecisionTemplate ||
				multiStepDecisionTemplate;
			const resolvedPlannerTemplate = resolveOptimizedPrompt(
				optimizedPlannerService,
				"action_planner",
				baselinePlannerTemplate,
			);
			const parsedStep = await runtime.dynamicPromptExecFromState({
				state: accumulatedState,
				params: {
					prompt: resolvedPlannerTemplate,
					...(promptAttachments ? { attachments: promptAttachments } : {}),
				},
				schema: [
					// Multi-step decision loop - internal reasoning, no streaming needed
					// WHY: This is orchestration logic, not user-facing output
					{
						field: "thought",
						description:
							"Your reasoning for the selected providers and/or action, and how this step contributes to resolving the user's request",
						validateField: false,
						streamField: false,
					},
					{
						field: "providers",
						description:
							"Comma-separated list of providers to call to gather necessary data",
						validateField: false,
						streamField: false,
					},
					{
						field: "action",
						description:
							"Name of the action to execute after providers return (can be empty if no action is needed)",
						validateField: false,
						streamField: false,
					},
					// WHY parameters: Actions need input data. Without this field in the schema,
					// the LLM won't be instructed to output parameters, breaking action execution.
					{
						field: "params",
						description:
							"Optional TOON parameters for the selected action. Use a `params` object keyed by action name when the action needs input.",
						validateField: false,
						streamField: false,
					},
					{
						field: "isFinish",
						description:
							"true if the task is fully resolved and no further steps are needed, false otherwise",
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.ACTION_PLANNER,
					preferredEncapsulation: "toon",
				},
			});

			if (!parsedStep) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount },
					"Failed to parse multi-step result",
				);
				traceActionResult.push({
					data: { actionName: "parse_error" },
					success: false,
					error: "Failed to parse step result",
				});
				return await this.buildStructuredFailureReply(
					runtime,
					message,
					withActionResults(accumulatedState, traceActionResult),
					responseId,
					"planning the next multi-step action",
				);
			}

			const thought =
				typeof parsedStep.thought === "string" ? parsedStep.thought : undefined;
			// Handle providers as comma-separated string or array
			let providers: string[] = [];
			if (Array.isArray(parsedStep.providers)) {
				providers = parsedStep.providers;
			} else if (typeof parsedStep.providers === "string") {
				providers = parsedStep.providers
					.split(",")
					.map((p: string) => p.trim())
					.filter((p: string) => p.length > 0);
			}
			const action =
				typeof parsedStep.action === "string" ? parsedStep.action : undefined;
			const isFinish = parsedStep.isFinish;

			// Check for completion condition
			if (isFinish === "true" || isFinish === true) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						iteration: iterationCount,
					},
					"Multi-step task completed",
				);
				if (callback) {
					await callback({
						text: "",
						thought: typeof thought === "string" ? thought : "",
					});
				}
				break;
			}

			// Validate that we have something to do
			const providersArray = Array.isArray(providers) ? providers : [];
			if ((!providersArray || providersArray.length === 0) && !action) {
				runtime.logger.warn(
					{ src: "service:message", iteration: iterationCount },
					"No providers or action specified, forcing completion",
				);
				break;
			}

			// Total timeout for all providers running in parallel (configurable via PROVIDERS_TOTAL_TIMEOUT_MS env var)
			// Since providers run in parallel, this is the max wall-clock time allowed
			const PROVIDERS_TOTAL_TIMEOUT_MS = parseInt(
				String(runtime.getSetting("PROVIDERS_TOTAL_TIMEOUT_MS") || "1000"),
				10,
			);

			// Track which providers have completed (for timeout diagnostics)
			const completedProviders = new Set<string>();

			const providerByName = new Map(
				runtime.providers.map((provider) => [provider.name, provider]),
			);
			const providerPromises: Array<
				Promise<{
					providerName: string;
					success: boolean;
					text?: string;
					error?: string;
				}>
			> = [];
			for (const name of providersArray) {
				if (typeof name !== "string") continue;
				providerPromises.push(
					(async (providerName: string) => {
						const provider = providerByName.get(providerName);
						if (!provider) {
							runtime.logger.warn(
								{ src: "service:message", providerName },
								"Provider not found",
							);
							completedProviders.add(providerName);
							return {
								providerName,
								success: false,
								error: `Provider not found: ${providerName}`,
							};
						}

						try {
							const providerResult = await provider.get(
								runtime,
								message,
								state,
							);
							completedProviders.add(providerName);

							if (!providerResult) {
								runtime.logger.warn(
									{ src: "service:message", providerName },
									"Provider returned no result",
								);
								return {
									providerName,
									success: false,
									error: "Provider returned no result",
								};
							}

							const success = !!providerResult.text;
							return {
								providerName,
								success,
								text: success ? providerResult.text : undefined,
								error: success ? undefined : "Provider returned no result",
							};
						} catch (err) {
							completedProviders.add(providerName);
							const errorMsg = err instanceof Error ? err.message : String(err);
							runtime.logger.error(
								{ src: "service:message", providerName, error: errorMsg },
								"Provider execution failed",
							);
							return { providerName, success: false, error: errorMsg };
						}
					})(name),
				);
			}

			// Create timeout promise for provider execution (with cleanup)
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutId = setTimeout(
					() => resolve("timeout"),
					PROVIDERS_TOTAL_TIMEOUT_MS,
				);
			});

			// Race between all providers completing and timeout
			const allProvidersPromise = Promise.allSettled(providerPromises);
			const raceResult = await Promise.race([
				allProvidersPromise,
				timeoutPromise,
			]);

			// Clear timeout if providers completed first
			if (timeoutId !== undefined) {
				clearTimeout(timeoutId);
			}

			// Check if providers took too long - abort pipeline and notify user
			if (raceResult === "timeout") {
				// Identify which providers were still pending when timeout hit
				const allProviderNames = providersArray.filter(
					(name): name is string => typeof name === "string",
				);
				const pendingProviders = allProviderNames.filter(
					(name) => !completedProviders.has(name),
				);

				runtime.logger.error(
					{
						src: "service:message",
						timeoutMs: PROVIDERS_TOTAL_TIMEOUT_MS,
						pendingProviders,
						completedProviders: Array.from(completedProviders),
					},
					`Providers took too long (>${PROVIDERS_TOTAL_TIMEOUT_MS}ms) - slow providers: ${pendingProviders.join(", ")}`,
				);

				if (callback) {
					const timeoutContent: Content = {
						text: "Providers took too long to respond. Please optimize your providers or use caching.",
						actions: [],
						thought: "Provider timeout - pipeline aborted",
					};
					await runtime.applyPipelineHooks(
						"outgoing_before_deliver",
						outgoingPipelineHookContext(timeoutContent, {
							source: "simple",
							roomId: message.roomId,
							message,
						}),
					);
					await callback(timeoutContent);
				}

				return {
					responseContent: null,
					responseMessages: [],
					state,
					mode: "none",
				};
			}

			// Providers completed in time
			const providerResults = raceResult;

			// Process results and notify via callback
			for (const result of providerResults) {
				if (result.status === "fulfilled") {
					const { providerName, success, text, error } = result.value;
					traceActionResult.push({
						data: { actionName: providerName },
						success,
						text,
						error,
					});

					if (callback) {
						await callback({
							text: `🔎 Provider executed: ${providerName}`,
							actions: [providerName],
							thought: typeof thought === "string" ? thought : "",
						});
					}
				} else {
					runtime.logger.error(
						{
							src: "service:message",
							error: result.reason || "Unknown provider failure",
						},
						"Unexpected provider promise rejection",
					);
				}
			}

			if (action) {
				const actionContent: Content = {
					text: `🔎 Executing action: ${action}`,
					actions: [action],
					thought: thought || "",
				};
				if (parsedStep && typeof parsedStep.params === "string") {
					actionContent.params = parsedStep.params;
				}

				await runtime.processActions(
					message,
					[
						{
							id: v4() as UUID,
							entityId: runtime.agentId,
							roomId: message.roomId,
							createdAt: Date.now(),
							content: actionContent,
						},
					],
					state,
					async () => {
						return [];
					},
				);

				// Get cached action results from runtime
				const cachedState = runtime.stateCache.get(
					`${message.id}_action_results`,
				);
				const cachedStateValues = cachedState?.values;
				const rawActionResults = cachedStateValues?.actionResults;
				const actionResults: ActionResult[] = Array.isArray(rawActionResults)
					? rawActionResults
					: [];
				const result: ActionResult | null =
					actionResults.length > 0 ? actionResults[0] : null;
				const success = result?.success ?? false;

				traceActionResult.push({
					data: { actionName: typeof action === "string" ? action : "unknown" },
					success,
					text:
						result && "text" in result && typeof result.text === "string"
							? result.text
							: undefined,
					values:
						result &&
						"values" in result &&
						typeof result.values === "object" &&
						result.values !== null
							? result.values
							: undefined,
					error: success
						? undefined
						: result && "text" in result && typeof result.text === "string"
							? result.text
							: undefined,
				});
			}
		}

		if (iterationCount >= opts.maxMultiStepIterations) {
			runtime.logger.warn(
				{ src: "service:message", maxIterations: opts.maxMultiStepIterations },
				"Reached maximum iterations, forcing completion",
			);
		}

		accumulatedState = withContextRoutingValues(
			(await runtime.composeState(
				message,
				["RECENT_MESSAGES", "ACTION_STATE"],
				false,
				false,
			)) as MultiStepState,
			contextRoutingStateValues,
		) as MultiStepState;

		// Use dynamicPromptExecFromState for final summary generation
		// Stream the final summary for better UX
		const summary = await runtime.dynamicPromptExecFromState({
			state: accumulatedState,
			params: {
				prompt:
					runtime.character.templates?.multiStepSummaryTemplate ||
					multiStepSummaryTemplate,
				...(promptAttachments ? { attachments: promptAttachments } : {}),
			},
			schema: [
				{
					field: "thought",
					description: "Your internal reasoning about the summary",
					validateField: false,
					streamField: false,
				},
				// WHY streamField: true? This is the final user-facing output
				{
					field: "text",
					description: "The final summary message to send to the user",
					required: true,
					streamField: true,
				},
			],
			options: {
				modelSize: "large",
				preferredEncapsulation: opts.onStreamChunk ? "xml" : "toon",
				requiredFields: ["text"],
				// Stream the final summary to the user
				onStreamChunk: opts.onStreamChunk,
			},
		});

		let responseContent: Content | null = null;
		const summaryText = summary?.text;
		if (typeof summaryText === "string" && summaryText) {
			responseContent = {
				actions: ["MULTI_STEP_SUMMARY"],
				text: summaryText,
				thought:
					(typeof summary?.thought === "string"
						? summary.thought
						: "Final user-facing message after task completion.") ||
					"Final user-facing message after task completion.",
				simple: true,
				responseId,
			};
		} else {
			return await this.buildStructuredFailureReply(
				runtime,
				message,
				withActionResults(accumulatedState, traceActionResult),
				responseId,
				"writing the final summary",
			);
		}

		const responseMessages: Memory[] = responseContent
			? [
					{
						id: responseId,
						entityId: runtime.agentId,
						agentId: runtime.agentId,
						content: responseContent,
						roomId: message.roomId,
						createdAt: Date.now(),
					},
				]
			: [];

		return {
			responseContent,
			responseMessages,
			state: accumulatedState,
			mode: responseContent ? "simple" : "none",
		};
	}

	/**
	 * Helper to emit run ended events
	 */
	private async emitRunEnded(
		runtime: IAgentRuntime,
		runId: UUID,
		message: Memory,
		startTime: number,
		status: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.RUN_ENDED, {
			runtime,
			source: "messageHandler",
			runId,
			messageId: message.id,
			roomId: message.roomId,
			entityId: message.entityId,
			startTime,
			status: status as "completed" | "timeout",
			endTime: Date.now(),
			duration: Date.now() - startTime,
		} as RunEventPayload);
	}

	private async emitMessageSent(
		runtime: IAgentRuntime,
		message: Memory,
		source: string,
	): Promise<void> {
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message,
			source,
		});
	}

	/**
	 * Deletes a message from the agent's memory.
	 * This method handles the actual deletion logic that was previously in event handlers.
	 *
	 * @param runtime - The agent runtime instance
	 * @param message - The message memory to delete
	 * @returns Promise resolving when deletion is complete
	 */
	async deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void> {
		if (!message.id) {
			runtime.logger.error(
				{ src: "service:message", agentId: runtime.agentId },
				"Cannot delete memory: message ID is missing",
			);
			return;
		}

		runtime.logger.info(
			{
				src: "service:message",
				agentId: runtime.agentId,
				messageId: message.id,
				roomId: message.roomId,
			},
			"Deleting memory",
		);
		await runtime.deleteMemory(message.id);
		runtime.logger.debug(
			{ src: "service:message", messageId: message.id },
			"Successfully deleted memory",
		);
	}

	/**
	 * Clears all messages from a channel/room.
	 * This method handles bulk deletion of all message memories in a room.
	 *
	 * @param runtime - The agent runtime instance
	 * @param roomId - The room ID to clear messages from
	 * @param channelId - The original channel ID (for logging)
	 * @returns Promise resolving when channel is cleared
	 */
	async clearChannel(
		runtime: IAgentRuntime,
		roomId: UUID,
		channelId: string,
	): Promise<void> {
		runtime.logger.info(
			{ src: "service:message", agentId: runtime.agentId, channelId, roomId },
			"Clearing message memories from channel",
		);

		// Get all message memories for this room
		const memories = await runtime.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds: [roomId],
		});

		runtime.logger.debug(
			{ src: "service:message", channelId, count: memories.length },
			"Found message memories to delete",
		);

		// Delete each message memory
		let deletedCount = 0;
		for (const memory of memories) {
			if (memory.id) {
				try {
					await runtime.deleteMemory(memory.id);
					deletedCount++;
				} catch (error) {
					runtime.logger.warn(
						{ src: "service:message", error, memoryId: memory.id },
						"Failed to delete message memory",
					);
				}
			}
		}

		runtime.logger.info(
			{
				src: "service:message",
				agentId: runtime.agentId,
				channelId,
				deletedCount,
				totalCount: memories.length,
			},
			"Cleared message memories from channel",
		);
	}
}

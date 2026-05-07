import { createRequire } from "node:module";
import { v4 } from "uuid";
import z from "zod";
import {
	formatActionNames,
	formatActions,
	parseActionParams,
	validateActionParams,
} from "../actions";
import { createUniqueUuid } from "../entities";
import {
	formatTaskCompletionStatus,
	getTaskCompletionCacheKey,
	type TaskCompletionAssessment,
} from "../features/advanced-capabilities/evaluators/task-completion";
import { looksLikeNonActionableChatter } from "../features/basic-capabilities/providers/non-actionable-chatter";
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
	getModelStreamChunkDeliveryDepth,
	runWithStreamingContext,
} from "../streaming-context";
import {
	runWithTrajectoryContext,
	setTrajectoryPurpose,
} from "../trajectory-context";
import type {
	Action,
	ActionParameters,
	ActionResult,
	HandlerCallback,
	StreamChunkCallback,
} from "../types/components";
import { isActionConfirmationStatus } from "../types/components";
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
import type { ProviderCacheEntry, State, StateValue } from "../types/state";
import {
	composePromptFromState,
	getLocalServerUrl,
	parseBooleanFromText,
	parseToonKeyValue,
	truncateToCompleteSentence,
} from "../utils";
import {
	collectActionResultSizeWarnings,
	formatActionResultsForPrompt,
	trimActionResultForPromptState,
} from "../utils/action-results";
import {
	AVAILABLE_CONTEXTS_STATE_KEY,
	attachAvailableContexts,
	CONTEXT_ROUTING_STATE_KEY,
	type ContextRoutingDecision,
	getActiveRoutingContexts,
	inferContextRoutingFromMessage,
	mergeContextRouting,
	parseContextRoutingMetadata,
	setContextRoutingMetadata,
} from "../utils/context-routing";
import { getUserMessageText } from "../utils/message-text";
import { createStreamingContext, MarkableExtractor } from "../utils/streaming";
import {
	extractFirstSentence,
	hasFirstSentence,
} from "../utils/text-splitting";
import { maybeHandleAnalysisActivation } from "./analysis-mode-handler";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptService,
} from "./optimized-prompt";
import { resolveOptimizedPrompt } from "./optimized-prompt-resolver";

const PLANNER_CONTROL_ACTIONS = new Set(
	["REPLY", "RESPOND", "IGNORE", "STOP"].map(normalizeActionIdentifier),
);

function canonicalPlannerControlActionName(actionName: string): string | null {
	const normalized = normalizeActionIdentifier(actionName);
	switch (normalized) {
		case "REPLY":
		case "RESPOND":
			return "REPLY";
		case "IGNORE":
			return "IGNORE";
		case "STOP":
			return "STOP";
		default:
			return null;
	}
}

function isReplyActionIdentifier(actionName: string): boolean {
	return canonicalPlannerControlActionName(actionName) === "REPLY";
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

	const safeText = text.length > 10_000 ? text.slice(0, 10_000) : text;
	return /<@!?[^>]+>|@\w+/u.test(safeText);
}

const DEFAULT_DUAL_PRESSURE_THRESHOLD = 20;
const ALLOWED_CLASSIFIER_ACTIONS = new Set([
	"REPLY",
	"RESPOND",
	"IGNORE",
	"STOP",
]);

type NativeReasoningModule = {
	runNativeReasoningLoop: (
		runtime: IAgentRuntime,
		message: Memory,
		callback: HandlerCallback,
		options?: {
			registry?: unknown;
			provider?: "anthropic" | "openai" | "codex";
			model?: string;
		},
	) => Promise<void>;
	buildDefaultRegistry: () => unknown;
};

type NativeToolCallingProvider = "anthropic" | "openai" | "codex";

interface NativeToolCallingCapability {
	provider: NativeToolCallingProvider;
	model?: string;
}

interface RuntimeModelRegistration {
	provider?: string;
	priority?: number;
	registrationOrder?: number;
}

const NATIVE_TOOL_CALLING_MODEL_TYPES = [
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_SMALL,
] as const;

function normalizeModelProvider(provider: unknown): string | null {
	if (typeof provider !== "string") {
		return null;
	}
	const normalized = provider.trim().toLowerCase();
	if (!normalized) {
		return null;
	}
	if (normalized.includes("anthropic") || normalized.includes("claude")) {
		return "anthropic";
	}
	if (normalized.includes("openai")) {
		return "openai";
	}
	if (normalized.includes("codex")) {
		return "codex";
	}
	if (
		normalized.includes("ollama") ||
		normalized.includes("lmstudio") ||
		normalized.includes("local")
	) {
		return "local";
	}
	return normalized;
}

function readRuntimeSetting(
	runtime: IAgentRuntime,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = runtime.getSetting?.(key);
		if (typeof value === "string" && value.trim() !== "") {
			return value.trim();
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}
	}
	return null;
}

function inferModelName(
	runtime: IAgentRuntime,
	provider: string | null,
): string | undefined {
	switch (provider) {
		case "anthropic":
			return (
				readRuntimeSetting(runtime, [
					"ANTHROPIC_LARGE_MODEL",
					"ANTHROPIC_MODEL",
					"LARGE_MODEL",
					"MODEL",
				]) ?? "claude-sonnet-4-6"
			);
		case "openai":
			return (
				readRuntimeSetting(runtime, [
					"OPENAI_LARGE_MODEL",
					"OPENAI_MODEL",
					"LARGE_MODEL",
					"MODEL",
				]) ?? "gpt-5"
			);
		case "codex":
			return readRuntimeSetting(runtime, ["CODEX_MODEL", "MODEL"]);
		case "local":
			return readRuntimeSetting(runtime, [
				"OLLAMA_MODEL",
				"LOCAL_MODEL",
				"MODEL",
				"LARGE_MODEL",
			]);
		default:
			return readRuntimeSetting(runtime, ["MODEL", "LARGE_MODEL"]);
	}
}

function getPreferredTextModelProvider(runtime: IAgentRuntime): string | null {
	const models = (runtime as unknown as { models?: unknown }).models;
	if (!(models instanceof Map)) {
		return null;
	}

	for (const modelType of NATIVE_TOOL_CALLING_MODEL_TYPES) {
		const registrations = models.get(String(modelType));
		if (!Array.isArray(registrations) || registrations.length === 0) {
			continue;
		}
		const [preferred] = registrations as RuntimeModelRegistration[];
		const provider = normalizeModelProvider(preferred?.provider);
		if (provider) {
			return provider;
		}
	}
	return null;
}

function inferConfiguredModelProvider(runtime: IAgentRuntime): string | null {
	const registeredProvider = getPreferredTextModelProvider(runtime);
	if (registeredProvider) {
		return registeredProvider;
	}
	if (
		readRuntimeSetting(runtime, ["NATIVE_REASONING_BACKEND"])
			?.trim()
			.toLowerCase() === "codex"
	) {
		return "codex";
	}
	if (
		readRuntimeSetting(runtime, ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"])
	) {
		return "anthropic";
	}
	if (readRuntimeSetting(runtime, ["OPENAI_API_KEY", "OPENAI_BASE_URL"])) {
		return "openai";
	}
	if (readRuntimeSetting(runtime, ["OLLAMA_BASE_URL", "LOCAL_LLM_BASE_URL"])) {
		return "local";
	}
	return null;
}

function modelSupportsNativeToolCalling(
	provider: string | null,
	model: string | undefined,
): provider is NativeToolCallingProvider {
	const normalizedModel = model?.trim().toLowerCase() ?? "";
	if (provider === "codex") {
		return true;
	}
	if (provider === "anthropic") {
		return normalizedModel === "" || normalizedModel.startsWith("claude-");
	}
	if (provider === "openai") {
		if (/^(text-|davinci|curie|babbage|ada)/u.test(normalizedModel)) {
			return false;
		}
		return /^(gpt-[45]|o[134]|codex)/u.test(normalizedModel);
	}
	// Local providers can support tools, but there is no common wire protocol to
	// assume from a provider name alone. Keep them on the prompt planner until
	// the provider advertises a concrete native backend/capability.
	return false;
}

function resolveNativeToolCallingCapability(
	runtime: IAgentRuntime,
): NativeToolCallingCapability | null {
	const provider = inferConfiguredModelProvider(runtime);
	const model = inferModelName(runtime, provider);
	if (!modelSupportsNativeToolCalling(provider, model)) {
		return null;
	}
	return {
		provider,
		...(model ? { model } : {}),
	};
}

export function isNativeToolCallingCapable(runtime: IAgentRuntime): boolean {
	return resolveNativeToolCallingCapability(runtime) !== null;
}

async function tryHandleWithNativeReasoning(
	runtime: IAgentRuntime,
	message: Memory,
	callback?: HandlerCallback,
): Promise<MessageProcessingResult | null> {
	const nativeToolCalling = resolveNativeToolCallingCapability(runtime);
	if (!nativeToolCalling) {
		return null;
	}

	let responseContent: Content | null = null;
	let responseFiles: Parameters<HandlerCallback>[1];
	let didRespond = false;
	const nativeCallback: HandlerCallback = async (content, files) => {
		responseContent = content;
		responseFiles = files;
		didRespond = typeof content.text === "string" && content.text.length > 0;
		return [];
	};

	try {
		const nativeReasoningPackage = "@elizaos/native-reasoning";
		let nativeReasoningSpecifier = nativeReasoningPackage;
		try {
			nativeReasoningSpecifier = createRequire(
				`${process.cwd()}/package.json`,
			).resolve(nativeReasoningPackage);
		} catch {
			// Fall back to the normal package resolver for published installs.
		}
		const nativeReasoning = (await import(
			nativeReasoningSpecifier
		)) as NativeReasoningModule;
		await nativeReasoning.runNativeReasoningLoop(
			runtime,
			message,
			nativeCallback,
			{
				registry: nativeReasoning.buildDefaultRegistry(),
				provider: nativeToolCalling.provider,
				model: nativeToolCalling.model,
			},
		);
	} catch (error) {
		runtime.logger.error(
			{
				src: "service:message",
				err: error instanceof Error ? error.message : String(error),
			},
			"Native reasoning runtime failed",
		);
		throw error;
	}

	const responseMessages: Memory[] = [];
	if (didRespond && responseContent !== null) {
		const finalContent = responseContent as Content;
		const responseId = finalContent.responseId ?? asUUID(v4());
		finalContent.responseId = responseId;
		if (message.id) {
			finalContent.inReplyTo = createUniqueUuid(runtime, message.id);
		}
		const responseMemory: Memory = {
			id: responseId,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			content: finalContent,
			roomId: message.roomId,
			createdAt: Date.now(),
		};
		responseMessages.push(responseMemory);

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(finalContent, {
				source: "native-reasoning",
				roomId: message.roomId,
				message,
				responseId,
			}),
		);
		await runtime.createMemory(responseMemory, "messages");
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: responseMemory,
			source: message.content.source ?? "messageHandler",
		});
		await callback?.(finalContent, responseFiles);
	}

	return {
		didRespond,
		responseContent,
		responseMessages,
		state: { values: {}, data: {}, text: "" } as State,
		mode: didRespond ? "simple" : "none",
		skipEvaluation: true,
		reason: "native-reasoning",
	};
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPlannerActionObjectName(action: Record<string, unknown>): string {
	const rawName = action.name ?? action.action ?? action.actionName;
	return typeof rawName === "string" ? unwrapPlannerIdentifier(rawName) : "";
}

function attachInlineToonActionParams(
	parsedToon: Record<string, unknown>,
	actionName: string,
	params: unknown,
): void {
	if (!actionName || !isRecord(params) || Object.keys(params).length === 0) {
		return;
	}

	const existingParams = parsedToon.params;
	const nextParams =
		isRecord(existingParams) && !Array.isArray(existingParams)
			? { ...existingParams }
			: {};
	nextParams[actionName.trim().toUpperCase()] = params;
	parsedToon.params = nextParams;
}

export function extractPlannerActionNames(
	parsedToon: Record<string, unknown>,
): string[] {
	return (() => {
		if (typeof parsedToon.actions === "string") {
			return parsedToon.actions
				.split(",")
				.map((action) => unwrapPlannerIdentifier(String(action)))
				.filter((action) => action.length > 0);
		}
		if (Array.isArray(parsedToon.actions)) {
			return parsedToon.actions
				.map((action) => {
					if (isRecord(action)) {
						const actionName = getPlannerActionObjectName(action);
						attachInlineToonActionParams(parsedToon, actionName, action.params);
						return actionName;
					}
					return unwrapPlannerIdentifier(String(action));
				})
				.filter((action) => action.length > 0);
		}
		return [];
	})();
}

function normalizePlannerActions(
	parsedToon: Record<string, unknown>,
	runtime: IAgentRuntime,
): string[] {
	const normalizedActions = extractPlannerActionNames(parsedToon);

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

		const controlActionName = canonicalPlannerControlActionName(actionName);
		if (controlActionName) {
			return [controlActionName];
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
		typeof parsedToon.text === "string" ? parsedToon.text.trim() : "";
	if (replyText.length > 0) return ["REPLY"];

	// Fallthrough: no valid action, no text. By the time the planner ran,
	// the shouldRespond gate already decided the bot needed to respond, so
	// landing on IGNORE here means the user sees silence even though the
	// framework chose to engage. That reads as "the bot is broken" to the
	// operator. Coerce to REPLY so the agent's reply handler emits at
	// least a short clarifying message (e.g. "not sure what you want — can
	// you be more specific?"). The only downside is an extra reply turn
	// on rare cases where the LLM emitted a totally empty response; that's
	// a better failure mode than dead silence.
	return ["REPLY"];
}

export function resolvePlannerActionName(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actionLookup: Map<string, Action> | undefined,
	actionName: string,
): string[] {
	const normalized = normalizeActionIdentifier(actionName);
	if (!normalized) {
		return [];
	}

	const controlActionName = canonicalPlannerControlActionName(actionName);
	if (controlActionName) {
		return [controlActionName];
	}

	const lookup =
		actionLookup ?? buildRuntimeActionLookup(runtime as IAgentRuntime);
	const resolvedAction = resolveRuntimeAction(lookup, actionName);
	if (resolvedAction) {
		return [resolvedAction.name];
	}

	const aliasedActionName = PLANNER_ACTION_ALIASES.get(normalized);
	if (aliasedActionName) {
		const resolvedAlias = resolveRuntimeAction(lookup, aliasedActionName);
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
}

function normalizePlannerProviders(
	parsedToon: Record<string, unknown>,
	runtime?: IAgentRuntime,
): string[] {
	const providerNames = extractPlannerProviderNames(parsedToon);

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
					const aliasedProvider = PLANNER_PROVIDER_ALIASES.get(
						normalizedProviderName,
					);
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
			const normalizedCompanion = normalizeActionIdentifier(canonicalCompanion);
			if (seenProviders.has(normalizedCompanion)) {
				continue;
			}
			seenProviders.add(normalizedCompanion);
			expandedProviders.push(canonicalCompanion);
		}
	}

	return expandedProviders;
}

function isStructuredPlannerIdentifier(value: string): boolean {
	const unwrapped = unwrapPlannerIdentifier(value).trim();
	return /^[A-Za-z][A-Za-z0-9_:-]*$/u.test(unwrapped);
}

function extractStructuredProviderList(rawProviders: string): string[] {
	const safe =
		rawProviders.length > 10_000 ? rawProviders.slice(0, 10_000) : rawProviders;
	const tokens = safe
		.split(/[\n,;]/)
		.map((providerName) =>
			providerName.replace(/^[\s"'[\](){}]+|[\s"'[\](){}]+$/g, ""),
		)
		.map((providerName) => unwrapPlannerIdentifier(providerName).trim())
		.filter((providerName) => providerName.length > 0);
	if (tokens.length === 0 || !tokens.every(isStructuredPlannerIdentifier)) {
		return [];
	}
	return tokens;
}

// Schemas for LLM-emitted provider lists embedded as JSON strings inside the
// planner TOON output. The planner sometimes returns providers as a JSON array
// of strings or as a `{ providers: string[] }` object instead of a TOON list.
// We coerce non-string entries to string and validate downstream.
const ProviderJsonArraySchema = z.array(z.unknown());
const ProviderJsonEnvelopeSchema = z.object({
	providers: z.array(z.unknown()),
});

export function extractPlannerProviderNames(
	parsedToon: Record<string, unknown>,
): string[] {
	const rawProviders = parsedToon.providers;
	if (typeof rawProviders === "string") {
		const trimmedProviders = rawProviders.trim();
		if (!trimmedProviders) {
			return [];
		}
		if (
			(trimmedProviders.startsWith("[") && trimmedProviders.endsWith("]")) ||
			(trimmedProviders.startsWith("{") && trimmedProviders.endsWith("}"))
		) {
			try {
				const parsedJson: unknown = JSON.parse(trimmedProviders);
				const arrayResult = ProviderJsonArraySchema.safeParse(parsedJson);
				if (arrayResult.success) {
					return arrayResult.data
						.map((providerName) => String(providerName).trim())
						.filter(
							(providerName): providerName is string =>
								providerName.length > 0 &&
								isStructuredPlannerIdentifier(providerName),
						);
				}
				const envelopeResult = ProviderJsonEnvelopeSchema.safeParse(parsedJson);
				if (envelopeResult.success) {
					return envelopeResult.data.providers
						.map((providerName) => String(providerName).trim())
						.filter(
							(providerName): providerName is string =>
								providerName.length > 0 &&
								isStructuredPlannerIdentifier(providerName),
						);
				}
				logger.warn(
					{
						raw: trimmedProviders,
						arrayErr: arrayResult.error.issues,
						envelopeErr: envelopeResult.error.issues,
					},
					"[message] LLM response failed schema validation",
				);
			} catch (err) {
				logger.warn(
					{ raw: trimmedProviders, err },
					"[message] LLM response failed schema validation",
				);
			}
		}

		return extractStructuredProviderList(trimmedProviders);
	}

	if (Array.isArray(rawProviders)) {
		return rawProviders.flatMap((providerName) => {
			if (typeof providerName !== "string") {
				const normalized = String(providerName).trim();
				return normalized.length > 0 &&
					isStructuredPlannerIdentifier(normalized)
					? [normalized]
					: [];
			}

			const trimmedProvider = providerName.trim();
			if (!trimmedProvider) {
				return [];
			}
			if (
				(trimmedProvider.startsWith("[") && trimmedProvider.endsWith("]")) ||
				(trimmedProvider.startsWith("{") && trimmedProvider.endsWith("}"))
			) {
				try {
					const parsedJson: unknown = JSON.parse(trimmedProvider);
					const arrayResult = ProviderJsonArraySchema.safeParse(parsedJson);
					if (arrayResult.success) {
						return arrayResult.data
							.map((entry) => String(entry).trim())
							.filter(
								(entry): entry is string =>
									entry.length > 0 && isStructuredPlannerIdentifier(entry),
							);
					}
					logger.warn(
						{ raw: trimmedProvider, err: arrayResult.error.issues },
						"[message] LLM response failed schema validation",
					);
				} catch (err) {
					logger.warn(
						{ raw: trimmedProvider, err },
						"[message] LLM response failed schema validation",
					);
				}
			}

			return extractStructuredProviderList(trimmedProvider);
		});
	}

	return [];
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

function hasInboundBenchmarkContext(message: Memory): boolean {
	const metadata = message.metadata as Record<string, unknown> | undefined;
	const benchmarkContext = metadata?.benchmarkContext;
	return (
		typeof benchmarkContext === "string" && benchmarkContext.trim().length > 0
	);
}

function composeResponseState(
	runtime: IAgentRuntime,
	message: Memory,
	skipCache = false,
): Promise<State> {
	const providers = hasInboundBenchmarkContext(message)
		? [...CORE_RESPONSE_STATE_PROVIDERS, "CONTEXT_BENCH"]
		: CORE_RESPONSE_STATE_PROVIDERS;
	return runtime.composeState(message, providers, true, skipCache);
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

function ensureActionStateValues(
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
): State {
	const currentActionNames =
		typeof state.values?.actionNames === "string" &&
		state.values.actionNames.trim().length > 0
			? state.values.actionNames
			: null;
	const currentDescriptions =
		typeof state.values?.actionsWithDescriptions === "string" &&
		state.values.actionsWithDescriptions.trim().length > 0
			? state.values.actionsWithDescriptions
			: null;

	if (currentActionNames && currentDescriptions) {
		return state;
	}

	const actionProviderEntry =
		state.data?.providers &&
		typeof state.data.providers === "object" &&
		state.data.providers !== null &&
		"ACTIONS" in state.data.providers
			? (state.data.providers.ACTIONS as {
					values?: Record<string, unknown>;
					data?: Record<string, unknown>;
				})
			: null;
	const providerValues =
		actionProviderEntry?.values &&
		typeof actionProviderEntry.values === "object" &&
		actionProviderEntry.values !== null
			? actionProviderEntry.values
			: null;

	let actionNames = currentActionNames;
	if (
		!actionNames &&
		typeof providerValues?.actionNames === "string" &&
		providerValues.actionNames.trim().length > 0
	) {
		actionNames = providerValues.actionNames;
	}

	let actionsWithDescriptions = currentDescriptions;
	if (
		!actionsWithDescriptions &&
		typeof providerValues?.actionsWithDescriptions === "string" &&
		providerValues.actionsWithDescriptions.trim().length > 0
	) {
		actionsWithDescriptions = providerValues.actionsWithDescriptions;
	}

	const actionsData =
		actionProviderEntry?.data &&
		typeof actionProviderEntry.data === "object" &&
		actionProviderEntry.data !== null &&
		"actionsData" in actionProviderEntry.data &&
		Array.isArray(actionProviderEntry.data.actionsData)
			? (actionProviderEntry.data.actionsData as Action[])
			: runtime.actions;

	if ((!actionNames || !actionsWithDescriptions) && actionsData.length > 0) {
		const actionSeed = `${runtime.agentId}:${message.roomId}:ACTIONS`;
		if (!actionNames) {
			actionNames = `Possible response actions: ${formatActionNames(actionsData, actionSeed)}`;
		}
		if (!actionsWithDescriptions) {
			actionsWithDescriptions = `# Available Actions\n${formatActions(actionsData, actionSeed)}`;
		}
	}

	if (!actionNames && !actionsWithDescriptions) {
		return state;
	}

	return {
		...state,
		values: {
			...(state.values ?? {}),
			...(actionNames ? { actionNames } : {}),
			...(actionsWithDescriptions ? { actionsWithDescriptions } : {}),
		},
	};
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
	onBeforeActionExecution?: MessageProcessingOptions["onBeforeActionExecution"];
};

async function invokeOnBeforeActionExecution(
	opts: ResolvedMessageOptions,
	runtime: IAgentRuntime,
	message: Memory,
): Promise<void> {
	if (opts.onBeforeActionExecution) {
		await opts.onBeforeActionExecution({ runtime, message });
	}
}

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
 * True when a plugin registered at least one core text delegate (chat / planning).
 * Embeddings-only (local-ai) and TTS do not count — without a matching delegate,
 * `dynamicPromptExecFromState` can fail with "No handler found for delegate type".
 */
export function hasTextGenerationHandler(runtime: IAgentRuntime): boolean {
	const keys: Array<keyof typeof ModelType | string> = [
		ModelType.TEXT_LARGE,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_NANO,
		ModelType.TEXT_MEGA,
		ModelType.ACTION_PLANNER,
		ModelType.RESPONSE_HANDLER,
	];
	for (const k of keys) {
		if (runtime.getModel(String(k))) return true;
	}
	return false;
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
		isReplyActionIdentifier(responseContent.actions[0])
	);
}

export function resolveStrategyMode(
	responseContent:
		| Pick<Content, "actions" | "text" | "simple">
		| null
		| undefined,
): StrategyMode {
	if (isStopResponse(responseContent)) {
		return "none";
	}

	if (!isSimpleReplyResponse(responseContent)) {
		return "actions";
	}

	const hasPlannerText =
		typeof responseContent?.text === "string" &&
		responseContent.text.trim().length > 0;

	return responseContent?.simple === true && hasPlannerText
		? "simple"
		: "actions";
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
	const safe = value.length > 10_000 ? value.slice(0, 10_000) : value;
	const trimmed = safe
		.trim()
		.replace(/^(?:[-*]|\d+[.)])\s+/, "")
		.replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) {
		return "";
	}
	return trimmed;
}

const PLANNER_ACTION_ALIASES = new Map(
	[
		["BULK_RESCHEDULE", "OWNER_CALENDAR"],
		["BULK_RESCHEDULE_MEETINGS", "OWNER_CALENDAR"],
		["SCHEDULE_MEETING", "OWNER_CALENDAR"],
		["RESCHEDULE_MEETINGS", "OWNER_CALENDAR"],
		["GET_AVAILABILITY", "OWNER_CALENDAR"],
		["CREATE_EVENT", "OWNER_CALENDAR"],
		["CREATE_RECURRING_EVENT", "OWNER_CALENDAR"],
		["CALENDAR_CREATE_RECURRING_EVENT", "OWNER_CALENDAR"],
		["SCHEDULE_RECURRING_EVENT", "OWNER_CALENDAR"],
		["SCHEDULE_RECURRING_MEETING", "OWNER_CALENDAR"],
		["SCHEDULE_RECURRING", "OWNER_CALENDAR"],
		["BOOK_TRAVEL_ACTION", "OWNER_VOICE_CALL"],
		["CAPTURE_TRAVEL_PREFERENCES", "OWNER_PROFILE"],
		["CAPTURE_BOOKING_PREFERENCES", "OWNER_PROFILE"],
		["CREATE_TRAVEL_PREFERENCES", "OWNER_PROFILE"],
		["SET_PREFERENCES", "OWNER_PROFILE"],
		["SET_TRAVEL_PREFERENCES", "OWNER_PROFILE"],
		["CREATE_FOLLOWUP", "OWNER_RELATIONSHIP"],
		["GET_PENDING_ASSETS", "LIST_INBOX"],
		["GET_PENDING_ITEMS", "LIST_INBOX"],
		["EVENT_ASSET_CHECKLIST", "LIST_INBOX"],
		["OUTSTANDING_EVENT_ASSETS", "LIST_INBOX"],
		["PORTAL_ASSET_CHECKLIST", "LIST_INBOX"],
		["PROPOSE_GROUP_CHAT_HANDOFF", "TRIAGE_MESSAGES"],
		["GROUP_CHAT_HANDOFF_POLICY", "TRIAGE_MESSAGES"],
		["SET_GROUP_CHAT_HANDOFF_POLICY", "TRIAGE_MESSAGES"],
		["CREATE_GROUP_CHAT", "SEND_DRAFT"],
		["BUMP_WITH_CONTEXT", "DRAFT_FOLLOWUP"],
		["CONTEXTUAL_BUMP", "DRAFT_FOLLOWUP"],
		["BUMP_UNANSWERED_DECISION", "DRAFT_FOLLOWUP"],
		["UPDATE_MORNING_BRIEF", "OWNER_CHECKIN"],
		["GET_PENDING_DRAFTS", "LIST_INBOX"],
		["ADD_MORNING_BRIEF_SECTION", "OWNER_CHECKIN"],
		["CREATE_REMINDER", "OWNER_LIFE"],
		["SET_REMINDER_RULE", "OWNER_LIFE"],
		["CREATE_REMINDER_RULE", "OWNER_DEVICE_INTENT"],
		["CREATE_DEVICE_WARNING", "OWNER_DEVICE_INTENT"],
		["REQUEST_UPDATED_ID", "OWNER_DEVICE_INTENT"],
		["CREATE_PREFERENCE_PROFILE", "OWNER_PROFILE"],
		["FLAG_CONFLICT", "OWNER_CALENDAR"],
		["CHECK_FLIGHT_CONFLICT", "OWNER_CALENDAR"],
		["FLIGHT_CONFLICT_REBOOKING", "OWNER_CALENDAR"],
		["REBOOK_CONFLICTING_EVENT", "OWNER_CALENDAR"],
		["SET_MULTI_DEVICE_MEETING_REMINDER", "OWNER_DEVICE_INTENT"],
		["SET_MULTI_DEVICE_REMINDER", "OWNER_DEVICE_INTENT"],
		["HANDLE_CANCELLATION_FEE", "OWNER_DEVICE_INTENT"],
		["CANCELLATION_FEE_WARNING", "OWNER_DEVICE_INTENT"],
		["WARN_CANCELLATION_FEE", "OWNER_DEVICE_INTENT"],
		["GET_ID_STATUS", "OWNER_DEVICE_INTENT"],
		["REQUEST_UPDATED_ID_COPY", "OWNER_DEVICE_INTENT"],
		["UPDATED_ID_COPY", "OWNER_DEVICE_INTENT"],
		["UPDATED_ID_INTERVENTION", "OWNER_DEVICE_INTENT"],
		["REQUEST_UPLOAD", "OWNER_COMPUTER_USE"],
		["UPLOAD_PORTAL", "OWNER_COMPUTER_USE"],
	].map(([from, to]) => [
		normalizeActionIdentifier(from),
		normalizeActionIdentifier(to),
	]),
);

const PLANNER_PROVIDER_ALIASES = new Map(
	[
		["DOCUMENT_LOOKUP", "ATTACHMENTS"],
		["INBOX_TRIAGE", "inboxTriage"],
		["PENDING_DRAFTS_PROVIDER", "inboxTriage"],
		["PENDING_DRAFTS", "inboxTriage"],
		["DRAFTS", "inboxTriage"],
	].map(([from, to]) => [normalizeActionIdentifier(from), to]),
);

const PROVIDER_FOLLOWUP_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE"].map(normalizeActionIdentifier),
);

const ACTION_REPAIR_PASSIVE_ACTIONS = new Set(
	["REPLY", "RESPOND", "NONE", "IGNORE"].map(normalizeActionIdentifier),
);

// Actions the planner selects as explicit delegation / orchestration intent.
// These cannot be evaluated by keyword-overlap against the user's message
// (e.g. "build me an app" does not contain "spawn" or "agent"), so the
// metadata-based corrector must not override them with a keyword-matched
// alternative like a cross-channel send action.
//
// CREATE_TRIGGER_TASK + its schedule similes are included because the phrase
// structure the planner matches on ("every N minutes", "at 7am daily",
// "schedule a cron task") does not keyword-overlap with the action's
// description the way OWNER_LIFE's multi-paragraph reminder/alarm prose does.
// Without these entries, the correction layer (findOwnedActionCorrectionFromMetadata)
// routinely overrides a correct CREATE_CRON/CREATE_TRIGGER_TASK pick on
// page-automations with OWNER_LIFE based on fuzzy description overlap — breaking
// the scope-gated routing on the page-automations surface.
// OWNER_RELATIONSHIP is the explicit umbrella action for the contacts /
// rolodex / follow-up surface. The metadata-based corrector would otherwise
// override a correct OWNER_RELATIONSHIP pick (subaction=add_follow_up) with
// SCHEDULE_FOLLOW_UP based on keyword overlap ("follow up with X next week"),
// even though SCHEDULE_FOLLOW_UP's validate explicitly returns false when
// OWNER_RELATIONSHIP is registered. The bypassed validate then surfaces a
// "Contact not found in relationships" error from the wrong action path.
// Treat OWNER_RELATIONSHIP as explicit planner intent so the corrector does
// not second-guess it.
//
// START_CODING_TASK is the orchestrator's coding-sub-agent delegation. When a user
// says "build me X" or "implement Y", the planner correctly picks START_CODING_TASK,
// but the user's prose contains zero START_CODING_TASK keywords. Without this entry
// the corrector overrides START_CODING_TASK with whatever role-gated action
// (OWNER_CALENDAR, TRIAGE_MESSAGES, MANAGE_ISSUES) happens to overlap with
// incidental words in the prompt — e.g. a build request that mentions a date
// keyword-rescores OWNER_CALENDAR over START_CODING_TASK and the user gets
// "Google Calendar is not connected" in response to a code request. Same
// precedent as SPAWN_AGENT, the sibling delegation action that's already
// protected here.
const EXPLICIT_INTENT_ACTIONS = new Set(
	[
		"SPAWN_AGENT",
		"START_CODING_TASK",
		"CREATE_TASK",
		"READ_ATTACHMENT",
		"TRANSCRIBE_MEDIA",
		"DOWNLOAD_MEDIA",
		"CHAT_WITH_ATTACHMENTS",
		"READ_CHANNEL",
		"SEARCH_MESSAGES",
		"SUMMARIZE_CONVERSATION",
		"LIST_CHANNELS",
		"SERVER_INFO",
		"CREATE_TRIGGER_TASK",
		"CREATE_TRIGGER",
		"SCHEDULE_TRIGGER",
		"SCHEDULE_TASK",
		"CREATE_HEARTBEAT",
		"SCHEDULE_HEARTBEAT",
		"CREATE_AUTOMATION",
		"SCHEDULE_AUTOMATION",
		"CREATE_CRON",
		"CREATE_RECURRING",
		"OWNER_RELATIONSHIP",
		// OWNER_LIFE picks routine / reminder / todo / habit / goal intents that
		// frequently mention a verb-noun pair the corrector will mis-rewrite.
		// "remember to call mom on Sunday" → planner correctly picks OWNER_LIFE
		// (a reminder), but the corrector keyword-rescores it to
		// OWNER_VOICE_CALL because of "call". Trust the planner's pick.
		"OWNER_LIFE",
	].map(normalizeActionIdentifier),
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
			ACTION_REPAIR_PASSIVE_ACTIONS.has(normalizeActionIdentifier(actionName)),
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
	const rawPlannerActions =
		args.rawPlannerActions.length > 0
			? `planner_actions_raw[${args.rawPlannerActions.length}]: ${args.rawPlannerActions.join(",")}`
			: "planner_actions_raw[0]:";
	const rawPlannerProviders =
		args.rawPlannerProviders.length > 0
			? `planner_providers_raw[${args.rawPlannerProviders.length}]: ${args.rawPlannerProviders.join(",")}`
			: "planner_providers_raw[0]:";
	const availableRuntimeActions =
		args.availableActionNames.length > 0
			? `available_runtime_actions[${args.availableActionNames.length}]: ${args.availableActionNames.join(",")}`
			: "available_runtime_actions[0]:";

	return [
		"You are repairing an action-planner output that used a non-canonical action name.",
		"Choose ONLY from the available runtime actions below.",
		"If the user explicitly asked for an operational artifact or workflow, select the responsible action instead of replying inline.",
		"If the subject is already present, do not ask a clarifying question just because the original planner used a generic lookup verb.",
		"Map generic planner labels like LOOKUP, SEARCH, FETCH, GET, RETRIEVE, BRIEF, or BACKGROUND to the best canonical runtime action.",
		"Return ONLY TOON with top-level fields: actions, providers, params, and optional text.",
		"Use actions[n]: ACTION_NAME for selected actions and a params object keyed by action name when inputs are needed.",
		"Do not include text unless there is truly no matching runtime action.",
		"",
		`user_message:\n${args.userText}`,
		"",
		rawPlannerActions,
		"",
		rawPlannerProviders,
		"",
		`planner_reply_text:\n${plannerReplyText}`,
		"",
		availableRuntimeActions,
		"",
		"Example:",
		'user_message: "Pull up a dossier on Satya Nadella."',
		"planner_actions_raw[1]: LOOKUP",
		"output:",
		"actions[1]: DOSSIER",
		"providers[0]:",
		"params:",
		"  DOSSIER:",
		"    subject: Satya Nadella",
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

	return args.runtime.dynamicPromptExecFromState({
		state: { values: {}, data: {}, text: "" } as State,
		params: {
			prompt: repairPrompt,
		},
		schema: [
			{
				field: "actions",
				description: "Selected canonical runtime action names",
				type: "array",
				items: { description: "One canonical runtime action name" },
				required: true,
				validateField: false,
				streamField: false,
			},
			{
				field: "providers",
				description: "Optional provider names needed before the action",
				type: "array",
				items: { description: "One provider name" },
				required: false,
				validateField: false,
				streamField: false,
			},
			{
				field: "params",
				description:
					"Optional TOON object keyed by action name with repaired action params",
				type: "object",
				required: false,
				validateField: false,
				streamField: false,
			},
			{
				field: "text",
				description:
					"Optional fallback reply only when no runtime action matches",
				required: false,
				validateField: false,
				streamField: false,
			},
		],
		options: {
			modelType: ModelType.TEXT_LARGE,
			preferredEncapsulation: "toon",
			contextCheckLevel: 0,
			maxRetries: 1,
		},
	});
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

function buildActionRescuePrompt(
	basePrompt: string,
	draftReply: string,
): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `\n[PREVIOUS DRAFT REPLY]\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n`
			: "";

	return `${basePrompt}

	[ACTION RESCUE]
	The previous draft stayed in prose-only mode or selected only passive reply actions.
	Re-evaluate the turn using the same available actions and providers already in context above.
	If a listed non-REPLY action owns the user's request, choose it now even when the text still needs to ask a follow-up question.
	Prefer the owning action for requests to create, store, remember, schedule, remind, upload, follow up, route, escalate, set a standing policy, delegate a future workflow, bulk-reschedule a cohort, run a morning brief, or call the owner when blocked.
	Missing details like the exact time, participant list, channel, platform, portal login, file arrival, itinerary specifics, or which item is at risk are not a reason to fall back to REPLY when a listed action can own the follow-up.
	When the user is defining a durable policy or future-condition workflow such as missed-call repair, contextual bumping, group-chat handoff, travel booking after approval, flight-conflict rebooking, portal upload after file arrival, updated-ID collection, multi-device meeting ladders, cancellation-fee warnings, outstanding event-asset checklists, or calling the owner if the agent gets stuck, picking only REPLY is wrong if a listed action can store or queue that behavior.
	For live checklist questions like what slides, bio, title, portal assets, drafts, or pending items the owner still owes, choose the owning inbox/calendar/computer-use action instead of answering from memory or treating it like a generic LifeOps reminder.
	If the draft reply merely acknowledges the task or asks for details before selecting an owning action, treat that draft as incomplete and repair it.
	Keep REPLY/NONE only when no listed action actually owns the request.${draftSection}`;
}

function buildActionOnlyRescuePrompt(draftReply: string): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `Draft reply:\n${trimmedDraftReply}\n\n`
			: "";

	return `Select the single best action for this turn using only the available actions already in context above.

	Rules:
	- Choose a listed non-REPLY action when the user is asking to create, store, remember, schedule, remind, upload, follow up, route, escalate, or set a standing policy.
	- If the request delegates a future workflow or approval-gated workflow, still choose the owning action even before every detail is present.
	- If the right action still needs clarification, choose that action anyway.
	- A reply that only says "tell me more", "which one?", "send it over", "I can do that", or "let me know the details" is wrong when an owning action can store or queue the workflow.
	- Durable requests like missed-call repair, contextual bump rules, group-chat handoff, travel booking after approval, flight-conflict rebooking, portal upload after file arrival, updated-ID collection, device reminder ladders, cancellation-fee warnings, event-asset checklists, and call-me-if-stuck escalations must choose the owning action on this turn.
	- Choose REPLY only when no listed action owns the request.
	- Do not invent action names.

Examples:
- "need to book 1 hour per day for time with Jill, any time is fine, ideally before sleep" -> OWNER_CALENDAR
- "I'm in Tokyo for limited time so let's schedule PendingReality and Ryan at the same time if possible" -> OWNER_CALENDAR
- "repair that missed call and hold the note for approval" -> TRIAGE_MESSAGES
- "if I still haven't answered about those three events, bump me again with context instead of starting over" -> DRAFT_FOLLOWUP
	- "if direct relaying gets messy, suggest a group chat handoff" -> TRIAGE_MESSAGES
	- "tell me what slides, bio, title, or portal assets I still owe before the event" -> LIST_INBOX
	- "in the morning brief, add a Pending Drafts section that lists what still needs my sign-off" -> OWNER_CHECKIN
	- "we're gonna cancel some stuff and push everything back until next month, all partnership meetings" -> OWNER_CALENDAR
	- "capture my reusable flight and hotel preferences" -> OWNER_PROFILE
	- "flag the conflict before my flight later and, if needed, help rebook the other thing" -> OWNER_CALENDAR
	- "I can go ahead and start booking the flights and hotel today if that's good with you" -> OWNER_BOOK_TRAVEL
	- "when I'm done with the PPT, upload it to the speaker portal for me" -> OWNER_COMPUTER_USE
	- "if the only ID on file is expired, ask me for an updated copy" -> OWNER_DEVICE_INTENT
	- "for important meetings, remind me an hour before, ten minutes before, and at start on my Mac and phone" -> OWNER_DEVICE_INTENT
	- "if missing this could trigger a cancellation fee, warn me clearly and offer to handle it now" -> OWNER_DEVICE_INTENT
	- "if you get stuck in the browser or on my computer, call me" -> OWNER_VOICE_CALL

${draftSection}Return TOON only:
thought: short reasoning
actions[1]: ACTION_NAME`;
}

const ROUTING_REASSESS_ACTIONS = new Set(
	[
		"OWNER_LIFE",
		"OWNER_DEVICE_INTENT",
		"OWNER_COMPUTER_USE",
		"OWNER_SUBSCRIPTIONS",
	].map(normalizeActionIdentifier),
);

const ACTION_OWNERSHIP_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"because",
	"can",
	"could",
	"do",
	"for",
	"from",
	"get",
	"go",
	"here",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"just",
	"let",
	"me",
	"my",
	"now",
	"of",
	"on",
	"or",
	"our",
	"please",
	"so",
	"that",
	"the",
	"them",
	"this",
	"to",
	"up",
	"we",
	"when",
	"with",
	"you",
	"your",
]);

const ACTION_OWNERSHIP_TRIGGER_PATTERNS = [
	/\b(?:if|when)\b/iu,
	/\b(?:upload|send over|send|attach)\b/iu,
	/\b(?:remind|warning|warn|nudge|alert)\b/iu,
	/\b(?:book|schedule|reschedule|follow up|bump|handoff|route|escalat|calls?)\b/iu,
	/\b(?:cancel|push|move|meeting|meetings|partnership|next month)\b/iu,
	/\b(?:remember|store|save|keep track|set (?:up|a|an)|policy|workflow)\b/iu,
	/\b(?:asset|assets|checklist|owe|owed|deadline|slides|bio|portal)\b/iu,
	/\b(?:sign|signature|appointment|clinic|docs?)\b/iu,
];

const ACTION_METADATA_FUTURE_HINTS =
	/\b(?:standing|future|workflow|policy|approval|delegate|gated|queued?|queue|intervention|nudge|warning|upload|portal|browser|device|follow[- ]?up)\b/iu;

type ActionOwnershipSuggestion = {
	actionName: string;
	score: number;
	secondBestScore: number;
	reasons: string[];
};

type ActionOwnershipCandidate = {
	actionName: string;
	score: number;
	reasons: string[];
};

function tokenizeOwnershipText(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.map((token) => token.trim())
		.filter(
			(token) => token.length >= 2 && !ACTION_OWNERSHIP_STOPWORDS.has(token),
		);
}

function buildTokenSet(text: string): Set<string> {
	return new Set(tokenizeOwnershipText(text));
}

function exampleContentText(action: Action): string[] {
	return (action.examples ?? []).flatMap((example) =>
		example.flatMap((turn) => {
			const text =
				typeof turn.content?.text === "string" ? turn.content.text.trim() : "";
			return text.length > 0 ? [text] : [];
		}),
	);
}

function splitActionMetadataText(value: string): string[] {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed
		.split(/(?:[\r\n]+|(?<=[.!?;])\s+)/u)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);
}

function actionMetadataTexts(action: Action): string[] {
	return [
		action.name,
		action.description,
		action.descriptionCompressed,
		...(action.tags ?? []),
		...(action.similes ?? []),
		...exampleContentText(action),
	]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.flatMap((value) => splitActionMetadataText(value));
}

function scoreActionOwnershipMatch(
	messageText: string,
	action: Action,
): { score: number; reasons: string[] } {
	const messageTokens = buildTokenSet(messageText);
	if (messageTokens.size === 0) {
		return { score: 0, reasons: [] };
	}

	let score = 0;
	const reasons: string[] = [];
	let bestExampleScore = 0;
	const normalizedMessage = messageText.toLowerCase();
	const actionMetadataBlob = actionMetadataTexts(action)
		.join(" ")
		.toLowerCase();

	for (const chunk of actionMetadataTexts(action)) {
		const chunkTokens = buildTokenSet(chunk);
		if (chunkTokens.size === 0) {
			continue;
		}
		const overlap = [...messageTokens].filter((token) =>
			chunkTokens.has(token),
		);
		if (overlap.length === 0) {
			continue;
		}
		const normalizedChunk = chunk.toLowerCase();
		const overlapRatio = overlap.length / Math.max(3, chunkTokens.size);
		if (
			/\b(?:do not use this for|don't use this for|not for|belongs? to)\b/iu.test(
				normalizedChunk,
			)
		) {
			score -= overlap.length * 1.25 + overlapRatio;
			if (overlap.length >= 2) {
				reasons.push(`negative:${overlap.slice(0, 4).join(",")}`);
			}
			continue;
		}
		score += overlap.length * 1.25 + overlapRatio;
		if (overlap.length >= 2) {
			reasons.push(`overlap:${overlap.slice(0, 4).join(",")}`);
		}

		if (
			normalizedChunk.length > 12 &&
			(normalizedMessage.includes(normalizedChunk) ||
				normalizedChunk.includes(normalizedMessage))
		) {
			score += 3;
			reasons.push("phrase");
		}

		const exampleTokens = tokenizeOwnershipText(chunk);
		if (exampleTokens.length >= 3) {
			const exampleOverlap = overlap.length / exampleTokens.length;
			if (exampleOverlap > bestExampleScore) {
				bestExampleScore = exampleOverlap;
			}
		}
	}

	if (bestExampleScore >= 0.6) {
		score += 4;
		reasons.push("example");
	}

	if (
		/\b(?:no calls? between|sleep window|blackout|preferred hours?|travel buffer|unless i explicitly say|unless i say it'?s okay)\b/iu.test(
			messageText,
		) &&
		/\b(?:sleep window|no-call|blackout|preferred hours?|meeting preferences|scheduling rules)\b/iu.test(
			actionMetadataBlob,
		)
	) {
		score += 4;
		reasons.push("schedule-policy");
	}

	if (
		ACTION_OWNERSHIP_TRIGGER_PATTERNS.some((pattern) =>
			pattern.test(messageText),
		) &&
		ACTION_METADATA_FUTURE_HINTS.test(
			[action.description, ...(action.tags ?? []), ...(action.similes ?? [])]
				.filter(Boolean)
				.join(" "),
		)
	) {
		score += 2;
		reasons.push("workflow");
	}

	return { score, reasons };
}

function findDirectOwnedActionSuggestion(
	runtime: Pick<IAgentRuntime, "actions">,
	messageText: string,
): ActionOwnershipSuggestion | null {
	if (
		/\b(?:no calls? between|sleep window|blackout|preferred hours?|travel buffer|unless i explicitly say|unless i say it'?s okay)\b/iu.test(
			messageText,
		)
	) {
		const ownerCalendarAction = (runtime.actions ?? []).find((action) => {
			const normalizedName = normalizeActionIdentifier(action.name);
			if (normalizedName === normalizeActionIdentifier("OWNER_CALENDAR")) {
				return true;
			}
			return (action.similes ?? []).some(
				(simile) =>
					normalizeActionIdentifier(simile) ===
						normalizeActionIdentifier("UPDATE_MEETING_PREFERENCES") ||
					normalizeActionIdentifier(simile) ===
						normalizeActionIdentifier("NO_CALL_HOURS") ||
					normalizeActionIdentifier(simile) ===
						normalizeActionIdentifier("PROTECT_SLEEP"),
			);
		});
		if (ownerCalendarAction) {
			return {
				actionName: ownerCalendarAction.name,
				score: 100,
				secondBestScore: 0,
				reasons: ["direct:schedule-policy"],
			};
		}
	}

	return null;
}

export function suggestOwnedActionFromMetadata(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Pick<Memory, "content">,
): ActionOwnershipSuggestion | null {
	const messageText = getUserMessageText(message);
	if (
		messageText.length === 0 ||
		!ACTION_OWNERSHIP_TRIGGER_PATTERNS.some((pattern) =>
			pattern.test(messageText),
		)
	) {
		return null;
	}

	const directSuggestion = findDirectOwnedActionSuggestion(
		runtime,
		messageText,
	);
	if (directSuggestion) {
		return directSuggestion;
	}

	const ranked: ActionOwnershipCandidate[] = (runtime.actions ?? [])
		.filter((action) => {
			const normalized = normalizeActionIdentifier(action.name);
			return (
				normalized.length > 0 &&
				!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(normalized) &&
				normalized !== normalizeActionIdentifier("IGNORE") &&
				normalized !== normalizeActionIdentifier("STOP")
			);
		})
		.map((action) => ({
			actionName: action.name,
			...scoreActionOwnershipMatch(messageText, action),
		}))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score);

	if (ranked.length === 0) {
		return null;
	}

	const best = ranked[0];
	const secondBestScore = ranked[1]?.score ?? 0;
	if (best.score < 8 || best.score - secondBestScore < 1.5) {
		return null;
	}

	return {
		actionName: best.actionName,
		score: best.score,
		secondBestScore,
		reasons: best.reasons,
	};
}

export function findOwnedActionCorrectionFromMetadata(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Pick<Memory, "content">,
	responseContent: Pick<Content, "actions"> | null | undefined,
): ActionOwnershipSuggestion | null {
	const hasExplicitIntent = (responseContent?.actions ?? []).some(
		(actionName) =>
			typeof actionName === "string" &&
			EXPLICIT_INTENT_ACTIONS.has(normalizeActionIdentifier(actionName)),
	);
	if (hasExplicitIntent) {
		return null;
	}

	const currentAction = responseContent?.actions?.find(
		(actionName) =>
			typeof actionName === "string" &&
			!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
				normalizeActionIdentifier(actionName),
			) &&
			normalizeActionIdentifier(actionName) !==
				normalizeActionIdentifier("IGNORE") &&
			normalizeActionIdentifier(actionName) !==
				normalizeActionIdentifier("STOP"),
	);
	if (!currentAction) {
		return null;
	}

	const suggestion = suggestOwnedActionFromMetadata(runtime, message);
	if (!suggestion) {
		return null;
	}

	if (
		normalizeActionIdentifier(suggestion.actionName) ===
		normalizeActionIdentifier(currentAction)
	) {
		return null;
	}

	const currentActionDef = (runtime.actions ?? []).find(
		(action) =>
			normalizeActionIdentifier(action.name) ===
			normalizeActionIdentifier(currentAction),
	);
	const currentScore = currentActionDef
		? scoreActionOwnershipMatch(
				typeof message.content?.text === "string" ? message.content.text : "",
				currentActionDef,
			).score
		: 0;
	if (suggestion.score - currentScore < 4) {
		return null;
	}

	return suggestion;
}

function hasNonPassiveAction(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	return (
		responseContent?.actions?.some(
			(actionName) =>
				typeof actionName === "string" &&
				!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
					normalizeActionIdentifier(actionName),
				) &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("IGNORE") &&
				normalizeActionIdentifier(actionName) !==
					normalizeActionIdentifier("STOP"),
		) ?? false
	);
}

/**
 * Returns true when the planner deliberately chose to converse — i.e. the
 * response actions list contains REPLY (or its alias RESPOND).
 *
 * REPLY is a deliberate signal that the LLM judged the message as
 * conversation, not a delegated task. The metadata-overlap rescue path
 * must respect this and not promote REPLY to a privileged action like
 * TRIAGE_MESSAGES or MANAGE_ISSUES based on incidental keyword overlap with
 * those actions' example text. Without this gate, a chitchat message
 * containing common scheduling/workflow words ("workflow", "policy",
 * "follow up", "friday", "2026") gets force-routed into a role-gated
 * action and the user sees "Permission denied: only the owner or admin
 * may use inbox actions" in response to plain conversation.
 */
function hasExplicitReplyIntent(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	const replyId = normalizeActionIdentifier("REPLY");
	const respondId = normalizeActionIdentifier("RESPOND");
	return (
		responseContent?.actions?.some((actionName) => {
			if (typeof actionName !== "string") return false;
			const id = normalizeActionIdentifier(actionName);
			return id === replyId || id === respondId;
		}) ?? false
	);
}

/**
 * Gate for the metadata-rescue path that promotes a passive (REPLY/NONE)
 * response to a privileged action based on keyword overlap. Run only when
 * the planner produced no real action AND no explicit REPLY — i.e. when
 * we genuinely have nothing to say.
 */
export function shouldRunMetadataActionRescue(
	responseContent: Pick<Content, "actions"> | null | undefined,
): boolean {
	if (hasNonPassiveAction(responseContent)) return false;
	if (hasExplicitReplyIntent(responseContent)) return false;
	return true;
}

function shouldAttemptActionRescue(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Memory,
	state: State,
	responseContent:
		| Pick<Content, "actions" | "providers" | "text">
		| null
		| undefined,
): boolean {
	if (!responseContent) {
		return false;
	}

	if (hasNonPassiveAction(responseContent)) {
		return false;
	}

	if (looksLikeNonActionableChatter(message)) {
		return false;
	}

	const availableActionNames =
		typeof state.values?.actionNames === "string"
			? state.values.actionNames
			: "";
	if (
		availableActionNames.trim().length === 0 &&
		(runtime.actions?.length ?? 0) === 0
	) {
		return false;
	}

	return true;
}

function getMessageText(message: Memory): string {
	return getUserMessageText(message);
}

function looksLikeOwnershipSensitiveRequest(message: Memory): boolean {
	const text = getMessageText(message).toLowerCase();
	if (!text) {
		return false;
	}

	return [
		/\bif\b/,
		/\bwhen\b/,
		/\bwhenever\b/,
		/\bapproval\b/,
		/\bapprove\b/,
		/\bgood with you\b/,
		/\bif needed\b/,
		/\brebook\b/,
		/\bgroup chat\b/,
		/\bhandoff\b/,
		/\bbump me again\b/,
		/\bwith context\b/,
		/\bwhat .* still owe\b/,
		/\bslides\b/,
		/\bportal assets?\b/,
		/\bupdated copy\b/,
		/\bexpired\b/,
		/\bcancellation fee\b/,
		/\bimportant meetings?\b/,
		/\bstuck\b/,
		/\bupload it to the portal\b/,
	].some((pattern) => pattern.test(text));
}

function shouldAttemptOwnershipRepair(
	runtime: Pick<IAgentRuntime, "actions">,
	message: Memory,
	state: State,
	responseContent:
		| Pick<Content, "actions" | "providers" | "text">
		| null
		| undefined,
): boolean {
	if (!responseContent || !hasNonPassiveAction(responseContent)) {
		return false;
	}

	if (looksLikeNonActionableChatter(message)) {
		return false;
	}

	const availableActionNames =
		typeof state.values?.actionNames === "string"
			? state.values.actionNames
			: "";
	if (
		availableActionNames.trim().length === 0 &&
		(runtime.actions?.length ?? 0) === 0
	) {
		return false;
	}

	const normalizedActions = (responseContent.actions ?? [])
		.map((actionName) =>
			typeof actionName === "string"
				? normalizeActionIdentifier(actionName)
				: "",
		)
		.filter((actionName) => actionName.length > 0);
	if (normalizedActions.length !== 1) {
		return false;
	}

	return (
		ROUTING_REASSESS_ACTIONS.has(normalizedActions[0]) &&
		looksLikeOwnershipSensitiveRequest(message)
	);
}

function buildOwnershipRepairPrompt(
	basePrompt: string,
	selectedActionName: string,
	draftReply: string,
): string {
	const trimmedDraftReply = draftReply.trim();
	const draftSection =
		trimmedDraftReply.length > 0
			? `\n[PREVIOUS DRAFT REPLY]\n${trimmedDraftReply.replace(/<\/response>/gi, "<\\/response>")}\n`
			: "";

	return `${basePrompt}

[OWNERSHIP REPAIR]
The previous plan selected ${selectedActionName}, but that action may be too broad or the wrong surface.
Re-evaluate the request and choose the single best owning action from the listed actions above.
Prefer the most specific owning action for inbox coordination, calendar conflict/rebooking, approval-gated travel booking, browser/portal workflows, device-warning policies, or owner-escalation workflows.
Generic contextual bump rules about unanswered events belong to TRIAGE_MESSAGES or OWNER_LIFE, not OWNER_DEVICE_INTENT, unless the owner explicitly asks for device-wide phone/desktop/mobile delivery.
Missing-ID or blocked-workflow prompts belong to OWNER_DEVICE_INTENT, OWNER_VOICE_CALL, SEND_DRAFT, or TRIAGE_MESSAGES, not OWNER_COMPUTER_USE, unless the assistant is actually operating a browser, portal, or file surface on the owner's machine.
Outstanding slides, bios, titles, portal assets, drafts, and other "what do I still owe?" questions belong to the owning inbox/calendar/browser action, not to OWNER_LIFE unless the request is explicitly about personal todo/habit state.
Cancellation-fee warnings and "warn me and offer to handle it now" policies belong to device-intent, calendar, or call escalation actions, not to OWNER_SUBSCRIPTIONS unless the user explicitly asks to audit, cancel, or status-check a named subscription.
Flight-conflict rebooking belongs to OWNER_CALENDAR even when the exact flight time or event ID still needs a follow-up.
If the current action is already the most specific owner, keep it.${draftSection}`;
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

export function shouldSkipDocumentProviderRescue(message: Memory): boolean {
	return (message.content.attachments?.length ?? 0) > 0;
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
TOON only. Return exactly one TOON document containing only provider names. No prose before or after it. No <think>.

Examples:
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "Which file are you referring to?"
  output:
  providers[2]: AVAILABLE_DOCUMENTS,KNOWLEDGE
- user asks: "what is the qa codeword from the uploaded file?"
  draft reply: "I don't have the file in my context. Which file contains the QA codeword?"
  output:
  providers[2]: AVAILABLE_DOCUMENTS,KNOWLEDGE
- user asks: "thanks, that's all"
  draft reply: "Glad to help."
  output:
  providers[0]:`;
}

async function recoverProvidersForTurn(args: {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	draftReply?: string;
	attachments?: GenerateTextAttachment[];
}): Promise<string[]> {
	if (shouldSkipDocumentProviderRescue(args.message)) {
		return [];
	}

	try {
		const parsed = await args.runtime.dynamicPromptExecFromState({
			state: args.state,
			params: {
				prompt: buildProviderSelectionPrompt(args.draftReply),
				...(args.attachments ? { attachments: args.attachments } : {}),
			},
			schema: [
				{
					field: "providers",
					description:
						"Provider names to call before replying, or an empty array",
					type: "array",
					items: { description: "One provider name" },
					required: true,
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "toon",
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
		const normalizedProviders = normalizePlannerProviders(
			parsed ?? { providers: [] },
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

recent conversation:
{{recentMessages}}

rules[5]:
- return true when the user is asking about an uploaded file, document, prior upload, or knowledge-base content
- return true when the answer is likely already stored in uploaded documents or semantic knowledge search
- when AVAILABLE_DOCUMENTS or KNOWLEDGE is available and the user refers to an uploaded file or prior upload, return true
- return false for generic chat, thanks, or requests that clearly do not depend on uploaded or knowledge-base content
- return only the structured output, with no prose

output:
TOON only. Return exactly one TOON document.

Examples:
- user asks: "what is the qa codeword from the uploaded file?" -> useKnowledgeProviders: true
- user asks: "thanks, that's all" -> useKnowledgeProviders: false`;
}

async function shouldUseKnowledgeProviders(
	runtime: IAgentRuntime,
	state: State,
	attachments?: GenerateTextAttachment[],
): Promise<boolean> {
	try {
		const parsed = await runtime.dynamicPromptExecFromState({
			state,
			params: {
				prompt: buildKnowledgeProviderDecisionPrompt(),
				...(attachments ? { attachments } : {}),
			},
			schema: [
				{
					field: "useKnowledgeProviders",
					description:
						"true when uploaded-document or knowledge providers should be consulted before replying",
					type: "boolean",
					required: true,
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "toon",
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
		const value =
			parsed?.useKnowledgeProviders ?? parsed?.use_knowledge_providers;
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

function buildRuntimeActionLookup(
	runtime: Pick<IAgentRuntime, "actions">,
): Map<string, Action> {
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

export type ActionContinuationDecision = {
	shouldContinue: boolean;
	suppressed: boolean;
	continuingActions: string[];
	suppressingActions: string[];
};

export function getActionContinuationDecision(
	runtime: Pick<IAgentRuntime, "actions">,
	responseContent: Content | null | undefined,
): ActionContinuationDecision {
	const actionLookup = buildRuntimeActionLookup(runtime);
	const continuingActions: string[] = [];
	const suppressingActions: string[] = [];

	for (const action of responseContent?.actions ?? []) {
		if (typeof action !== "string") continue;

		const resolvedAction = resolveRuntimeAction(actionLookup, action);
		if (resolvedAction?.suppressPostActionContinuation) {
			suppressingActions.push(resolvedAction.name);
			continue;
		}

		const canonicalAction =
			resolvedAction?.name ??
			canonicalPlannerControlActionName(action) ??
			action;
		if (
			!TERMINAL_ACTION_IDENTIFIERS.has(
				normalizeActionIdentifier(canonicalAction),
			)
		) {
			continuingActions.push(canonicalAction);
		}
	}

	const suppressed = suppressingActions.length > 0;
	return {
		shouldContinue: !suppressed && continuingActions.length > 0,
		suppressed,
		continuingActions,
		suppressingActions,
	};
}

function shouldContinueAfterActions(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	return getActionContinuationDecision(runtime, responseContent).shouldContinue;
}

function suppressesPostActionContinuation(
	runtime: IAgentRuntime,
	responseContent: Content | null | undefined,
): boolean {
	return getActionContinuationDecision(runtime, responseContent).suppressed;
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

	const canonicalFirstAction =
		resolvedAction?.name ??
		canonicalPlannerControlActionName(firstAction) ??
		firstAction;
	const normalizedFirstAction = normalizeActionIdentifier(canonicalFirstAction);

	return (
		normalizedFirstAction !== normalizeActionIdentifier("REPLY") &&
		normalizedFirstAction !== normalizeActionIdentifier("IGNORE") &&
		normalizedFirstAction !== normalizeActionIdentifier("STOP")
	);
}

// Actions that are passive bookkeeping / chitchat. Safe to drop when a
// turn-owning action (one that sets suppressPostActionContinuation = true,
// e.g. SPAWN_AGENT) is also picked for the same turn. Keeping them around
// alongside explicit delegation produces duplicate user-visible noise:
// "Created task X" message followed by the actual delegated result.
const PASSIVE_TURN_ACTIONS = new Set(
	["REPLY", "RESPOND", "MANAGE_TASKS"].map(normalizeActionIdentifier),
);

export function stripReplyWhenActionOwnsTurn(
	runtime: Pick<IAgentRuntime, "actions" | "logger">,
	actions: readonly string[] | null | undefined,
): string[] {
	if (!actions || actions.length <= 1) {
		return Array.isArray(actions) ? [...actions] : [];
	}

	const hasPassive = actions.some((action) =>
		PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	if (!hasPassive) {
		return [...actions];
	}

	const actionLookup = buildRuntimeActionLookup(runtime);
	const ownedActions = actions.filter((action) => {
		const normalized = normalizeActionIdentifier(action);
		if (!normalized || PASSIVE_TURN_ACTIONS.has(normalized)) {
			return false;
		}
		return (
			resolveRuntimeAction(actionLookup, action)
				?.suppressPostActionContinuation === true
		);
	});
	if (ownedActions.length === 0) {
		return [...actions];
	}

	const filtered = actions.filter(
		(action) => !PASSIVE_TURN_ACTIONS.has(normalizeActionIdentifier(action)),
	);
	runtime.logger.info(
		{
			src: "service:message",
			originalActions: actions,
			filteredActions: filtered,
			suppressedBy: ownedActions,
		},
		"Dropped passive actions because another selected action already owns the turn",
	);
	return filtered.length > 0 ? filtered : ["REPLY"];
}

export function wrapSingleTurnVisibleCallback(
	_runtime: Pick<IAgentRuntime, "agentId" | "logger">,
	_message: Pick<Memory, "id" | "roomId">,
	callback?: HandlerCallback,
): HandlerCallback | undefined {
	return callback;
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
		if (!isReplyActionIdentifier(actionName)) {
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
		return isReplyActionIdentifier(actionName);
	});
}

export function withActionResultsForPrompt(
	state: State,
	actionResults: ActionResult[],
): State {
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

const withActionResults = withActionResultsForPrompt;

function preparePromptActionResult<T extends ActionResult>(
	runtime: IAgentRuntime,
	message: Memory,
	result: T,
): T {
	for (const warning of collectActionResultSizeWarnings(result)) {
		runtime.logger.warn(
			{
				src: "service:message",
				agentId: runtime.agentId,
				messageId: message.id,
				roomId: message.roomId,
				action: warning.actionName,
				field: warning.field,
				rawCharLength: warning.rawCharLength,
				estimatedTokens: warning.estimatedTokens,
				thresholdTokens: warning.thresholdTokens,
			},
			"Action result exceeds prompt-size warning threshold",
		);
	}

	return trimActionResultForPromptState(result);
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

function withInferredContextRoutingFallback(
	routing: ContextRoutingDecision,
	message: Memory,
): ContextRoutingDecision {
	if (getActiveRoutingContexts(routing).length > 0) {
		return routing;
	}
	const inferred = inferContextRoutingFromMessage(message);
	return {
		...inferred,
		evidenceTurnIds: routing.evidenceTurnIds,
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
		// Analysis-mode token detection runs BEFORE any planner work so the
		// agent never hallucinates a "performing an analysis" reply. Gated by
		// `MILADY_ENABLE_ANALYSIS_MODE` / `NODE_ENV=development`. See
		// services/analysis-mode-handler.ts and review #15.
		const analysisActivation = maybeHandleAnalysisActivation({
			text: message.content?.text,
			roomId: message.roomId,
		});
		if (analysisActivation.handled) {
			if (callback && typeof analysisActivation.responseText === "string") {
				await callback({
					text: analysisActivation.responseText,
					thought: "analysis-mode toggle",
				});
			}
			return {
				didRespond: true,
				responseContent: {
					text: analysisActivation.responseText ?? "",
					thought: "analysis-mode toggle",
				},
				responseMessages: [],
				state: { values: {}, data: {}, text: "" } as State,
				mode: "none",
				skipEvaluation: true,
				reason: "analysis-mode-token",
			};
		}

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
		let trajectoryId =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryId" in message.metadata
				? (message.metadata as { trajectoryId?: string }).trajectoryId
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
			trajectoryId =
				typeof message.metadata === "object" &&
				message.metadata !== null &&
				"trajectoryId" in message.metadata
					? (message.metadata as { trajectoryId?: string }).trajectoryId
					: undefined;
		}

		return await runWithTrajectoryContext<MessageProcessingResult>(
			typeof trajectoryStepId === "string" && trajectoryStepId.trim() !== ""
				? {
						...(typeof trajectoryId === "string" && trajectoryId.trim() !== ""
							? { trajectoryId: trajectoryId.trim() }
							: {}),
						trajectoryStepId: trajectoryStepId.trim(),
						runId: runtime.getCurrentRunId?.(),
						roomId: message.roomId,
						messageId: message.id,
					}
				: undefined,
			async (): Promise<MessageProcessingResult> => {
				const nativeResult = await tryHandleWithNativeReasoning(
					runtime,
					message,
					callback,
				);
				if (nativeResult) {
					return nativeResult;
				}

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
				// separate AsyncLocalStorage streaming context:
				//
				// Previously handleMessage created a second extractor through
				// runWithStreamingContext. Both extractors received the same raw LLM
				// tokens in useModel and emitted independently, causing the
				// dual-extractor garbling bug; consumers saw overlapping deltas that
				// produced unintelligible TTS.
				//
				// The fix: a single TOON field extractor in
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
								// Raw-token streams (no accumulated) may contain partial
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
					onBeforeActionExecution: options?.onBeforeActionExecution,
				};

				const instrumentedCallback = wrapSingleTurnVisibleCallback(
					runtime,
					message,
					callback,
				);

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

					// Structured TOON streaming is handled by dynamicPromptExecFromState,
					// which receives opts.onStreamChunk directly and extracts only fields
					// marked as streamable in the schema.
					const streamingContext = undefined;
					// Voice handling state
					const firstSentenceSent = false;
					const firstSentenceText = "";

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
					if (message.id) {
						runtime.stateCache.delete(`${message.id}_action_results`);
					}
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
		} else if (!hasTextGenerationHandler(runtime)) {
			await runtime.applyPipelineHooks(
				"parallel_with_should_respond",
				parallelHookCtx,
			);
			// Skip LLM should-respond classification when no text delegate is
			// registered — `dynamicPromptExecFromState` would throw "No handler found".
			// Still apply the same non-LLM gates as `runNonAutonomousShouldRespondClassify`:
			// only respond for DM / mention / reply / whitelisted source / etc. Ambiguous
			// group traffic that would need the classifier must not auto-reply with
			// NO_LLM_PROVIDER_REPLY (channel flood).
			const checkShouldRespondEnabled = runtime.isCheckShouldRespondEnabled();
			const responseDecision = this.shouldRespond(
				runtime,
				message,
				room ?? undefined,
				mentionContext,
			);
			if (!checkShouldRespondEnabled) {
				routedDecision = withInferredContextRoutingFallback({}, message);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = true;
			} else if (responseDecision.skipEvaluation) {
				routedDecision = withInferredContextRoutingFallback(
					parseContextRoutingMetadata(responseDecision),
					message,
				);
				setContextRoutingMetadata(message, routedDecision);
				shouldRespondToMessage = responseDecision.shouldRespond;
			} else {
				runtime.logger.debug(
					{
						src: "service:message",
						agentId: runtime.agentId,
						reason: responseDecision.reason,
					},
					"No text-generation handler: skipping message that requires LLM should-respond",
				);
				shouldRespondToMessage = false;
			}
			terminalDecision = null;
			dualPressureLog = null;
			shouldRespondClassifierAction = null;
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
			const hasResolvedRouting =
				getActiveRoutingContexts(resolvedRouting).length > 0;
			let executionState = state;
			if (hasResolvedRouting) {
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

			// Race check before we send anything.
			//
			// When a newer message arrives in the same room while we were
			// generating a response, the default behavior is to drop the older
			// response so the bot only replies to the freshest input.
			//
			// Exception: keep the response when the planner picked an explicit
			// REPLY/RESPOND action. That's a deliberate conversational signal
			// (often a direct @-mention) and dropping it leaves the user looking
			// at silence on a tagged message, which the character contract
			// treats as a bug. The newer message will get its own turn through
			// the normal pipeline; sending the older REPLY first does not
			// duplicate either response.
			const currentResponseId = agentResponses.get(message.roomId);
			if (currentResponseId !== responseId && !opts.keepExistingResponses) {
				if (hasExplicitReplyIntent(responseContent)) {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							roomId: message.roomId,
						},
						"Race detected but keeping response (explicit REPLY for an addressed message)",
					);
				} else {
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
			}

			if (responseContent && message.id) {
				responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
			}

			const providerStateValues = {
				[AVAILABLE_CONTEXTS_STATE_KEY]:
					state.values?.[AVAILABLE_CONTEXTS_STATE_KEY],
				[CONTEXT_ROUTING_STATE_KEY]: state.values?.[CONTEXT_ROUTING_STATE_KEY],
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

				if (
					responseContent?.providers &&
					responseContent.providers.length > 0
				) {
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
					await invokeOnBeforeActionExecution(opts, runtime, message);
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

		if (opts.continueAfterActions && message.id && !isBenchmarkMode(state)) {
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
				// reply (e.g. OWNER_CALENDAR) will get a second visible callback
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
			routedDecision = withInferredContextRoutingFallback({}, message);
			setContextRoutingMetadata(message, routedDecision);
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
			routedDecision = withInferredContextRoutingFallback(
				parseContextRoutingMetadata(responseDecision),
				message,
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
			routedDecision = withInferredContextRoutingFallback(
				parseContextRoutingMetadata(responseObject),
				message,
			);
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
						runtime.getService<OptimizedPromptService>(
							OPTIMIZED_PROMPT_SERVICE,
						);
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
						const parsedToon = parseToonKeyValue(response);

						if (parsedToon && (parsedToon.description || parsedToon.text)) {
							processedAttachment.description =
								(typeof parsedToon.description === "string"
									? parsedToon.description
									: "") || "";
							processedAttachment.title =
								(typeof parsedToon.title === "string"
									? parsedToon.title
									: "Image") || "Image";
							processedAttachment.text =
								(typeof parsedToon.text === "string" ? parsedToon.text : "") ||
								(typeof parsedToon.description === "string"
									? parsedToon.description
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
							runtime.logger.warn(
								{ src: "service:message" },
								"Failed to parse TOON response for image description",
							);
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

			await invokeOnBeforeActionExecution(opts, runtime, message);
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

			// Break the post-action continuation loop when any of the just-run
			// actions returned a "needs human confirmation" signal. The
			// confirmation has to come from the next user message — there is
			// nothing the agent can do to supply it on its own. Without this,
			// OWNER_REMOTE_DESKTOP / SEND_DRAFT confirm-then-dispatch /
			// OWNER_WEBSITE_BLOCK re-fire their plan every iteration until
			// maxMultiStepIterations is hit.
			const requiresConfirmation = latestActionResults.some((r) => {
				const v =
					r &&
					"values" in r &&
					typeof r.values === "object" &&
					r.values !== null
						? (r.values as Record<string, unknown>)
						: null;
				const d =
					r && "data" in r && typeof r.data === "object" && r.data !== null
						? (r.data as Record<string, unknown>)
						: null;
				return (
					v?.requiresConfirmation === true ||
					d?.requiresConfirmation === true ||
					isActionConfirmationStatus(v?.error) ||
					isActionConfirmationStatus(d?.error)
				);
			});
			if (requiresConfirmation) {
				runtime.logger.info(
					{
						src: "service:message",
						agentId: runtime.agentId,
						iteration: iterationCount + 1,
					},
					"Post-action continuation: action returned requiresConfirmation — terminating loop until next user message",
				);
				break;
			}
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

		await invokeOnBeforeActionExecution(opts, runtime, message);
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
		state = ensureActionStateValues(runtime, message, state);

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
		const parsedPlanner = await runtime.dynamicPromptExecFromState({
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
						"Ordered action entries. Use TOON action names, optionally with params nested under the selected action.",
					type: "array",
					items: { description: "One action name or action entry" },
					required: false,
					validateField: false,
					streamField: false,
				},
				{
					field: "providers",
					description:
						"Optional provider names to call before the final reply or action. Use an empty field when no provider lookup is needed.",
					type: "array",
					items: { description: "One provider name" },
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
				preferredEncapsulation: "toon",
				maxRetries: opts.maxRetries,
				// Stream through the filtered context callback for real-time output
				onStreamChunk: streamingCtx?.onStreamChunk,
			},
		});

		runtime.logger.debug(
			{ src: "service:message", parsedPlanner },
			"Parsed Response Content",
		);

		if (parsedPlanner) {
			// Mark streaming as complete now that we have a valid response
			streamingExtractor?.markComplete();
			const rawPlannerActions = extractPlannerActionNames(
				parsedPlanner as Record<string, unknown>,
			);
			let finalActions = normalizePlannerActions(
				parsedPlanner as Record<string, unknown>,
				runtime,
			);
			let normalizedProviders = normalizePlannerProviders(
				parsedPlanner as Record<string, unknown>,
				runtime,
			);

			if (shouldAttemptCanonicalActionRepair(rawPlannerActions, finalActions)) {
				const repairedPlannerOutput = await repairCanonicalPlannerActions({
					runtime,
					message,
					rawPlannerActions,
					rawPlannerProviders: normalizedProviders,
					plannerReplyText: String(parsedPlanner.text || ""),
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
							parsedPlanner.params = repairedPlannerOutput.params;
						}
					}
				}
			}

			responseContent = {
				...parsedPlanner,
				thought: String(parsedPlanner.thought || ""),
				actions: finalActions,
				providers: normalizedProviders,
				text: String(parsedPlanner.text || ""),
				simple:
					parsedPlanner.simple === true || parsedPlanner.simple === "true",
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
Return TOON only with the continuation in the text field, starting immediately after the last character above.`;

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
						preferredEncapsulation: "toon",
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
				message,
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

		if (
			!overrides?.providerFollowup &&
			shouldAttemptActionRescue(runtime, message, state, responseContent)
		) {
			const actionRescuePrompt = buildActionRescuePrompt(
				prompt,
				String(responseContent.text || ""),
			);
			const rescuedActionToon = await runtime.dynamicPromptExecFromState({
				state,
				params: {
					prompt: actionRescuePrompt,
					...(promptAttachments ? { attachments: promptAttachments } : {}),
				},
				schema: [
					{
						field: "thought",
						description:
							"Short reasoning about whether a grounded action should own the turn",
						validateField: false,
						streamField: false,
					},
					{
						field: "actions",
						description:
							"Ordered action entries. Use TOON action names, optionally with params nested under the selected action.",
						type: "array",
						items: { description: "One action name or action entry" },
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "providers",
						description:
							"Optional provider names to call before the final reply or action. Use an empty field when no provider lookup is needed.",
						type: "array",
						items: { description: "One provider name" },
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "text",
						description: "The text response to send to the user",
						streamField: false,
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
					preferredEncapsulation: "toon",
					maxRetries: 1,
				},
			});

			if (rescuedActionToon) {
				const rescuedContent: Content = {
					...rescuedActionToon,
					thought: String(rescuedActionToon.thought || ""),
					actions: normalizePlannerActions(
						rescuedActionToon as Record<string, unknown>,
						runtime,
					),
					providers: normalizePlannerProviders(
						rescuedActionToon as Record<string, unknown>,
						runtime,
					),
					text:
						typeof rescuedActionToon.text === "string" &&
						rescuedActionToon.text.trim().length > 0
							? String(rescuedActionToon.text)
							: responseContent.text,
					simple:
						rescuedActionToon.simple === true ||
						rescuedActionToon.simple === "true",
				};

				if (
					hasNonPassiveAction(rescuedContent) ||
					(rescuedContent.providers?.length ?? 0) >
						(responseContent.providers?.length ?? 0)
				) {
					runtime.logger.info(
						{
							src: "service:message",
							originalActions: responseContent.actions ?? [],
							rescuedActions: rescuedContent.actions ?? [],
							rescuedProviders: rescuedContent.providers ?? [],
						},
						"Recovered grounded action plan after passive reply draft",
					);
					responseContent = rescuedContent;
				}
			}
		}

		if (
			!overrides?.providerFollowup &&
			shouldAttemptOwnershipRepair(runtime, message, state, responseContent)
		) {
			const selectedActionName =
				(typeof responseContent.actions?.[0] === "string" &&
					responseContent.actions[0]) ||
				"UNKNOWN_ACTION";
			const ownershipRepairPrompt = buildOwnershipRepairPrompt(
				prompt,
				selectedActionName,
				String(responseContent.text || ""),
			);
			const repairedOwnershipToon = await runtime.dynamicPromptExecFromState({
				state,
				params: {
					prompt: ownershipRepairPrompt,
					...(promptAttachments ? { attachments: promptAttachments } : {}),
				},
				schema: [
					{
						field: "thought",
						description:
							"Short reasoning about whether a more specific owning action should replace the current one",
						validateField: false,
						streamField: false,
					},
					{
						field: "actions",
						description:
							"Ordered action entries. Use TOON action names, optionally with params nested under the selected action.",
						type: "array",
						items: { description: "One action name or action entry" },
						required: true,
						validateField: false,
						streamField: false,
					},
					{
						field: "providers",
						description:
							"Optional provider names to call before the final reply or action. Use an empty field when no provider lookup is needed.",
						type: "array",
						items: { description: "One provider name" },
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "text",
						description: "The text response to send to the user",
						streamField: false,
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
					preferredEncapsulation: "toon",
					maxRetries: 1,
				},
			});

			if (repairedOwnershipToon) {
				const repairedOwnershipContent: Content = {
					...repairedOwnershipToon,
					thought: String(repairedOwnershipToon.thought || ""),
					actions: normalizePlannerActions(
						repairedOwnershipToon as Record<string, unknown>,
						runtime,
					),
					providers: normalizePlannerProviders(
						repairedOwnershipToon as Record<string, unknown>,
						runtime,
					),
					text:
						typeof repairedOwnershipToon.text === "string" &&
						repairedOwnershipToon.text.trim().length > 0
							? String(repairedOwnershipToon.text)
							: responseContent.text,
					simple:
						repairedOwnershipToon.simple === true ||
						repairedOwnershipToon.simple === "true",
				};

				if (
					hasNonPassiveAction(repairedOwnershipContent) &&
					JSON.stringify(repairedOwnershipContent.actions ?? []) !==
						JSON.stringify(responseContent.actions ?? [])
				) {
					runtime.logger.info(
						{
							src: "service:message",
							originalActions: responseContent.actions ?? [],
							repairedActions: repairedOwnershipContent.actions ?? [],
							repairedProviders: repairedOwnershipContent.providers ?? [],
						},
						"Replaced broad routing action with a more specific owning action",
					);
					responseContent = repairedOwnershipContent;
				}
			}
		}

		if (
			!overrides?.providerFollowup &&
			shouldAttemptActionRescue(runtime, message, state, responseContent)
		) {
			const actionOnlyRescue = await runtime.dynamicPromptExecFromState({
				state,
				params: {
					prompt: buildActionOnlyRescuePrompt(
						String(responseContent.text || ""),
					),
				},
				schema: [
					{
						field: "thought",
						description:
							"Short reasoning about the single best grounded action",
						validateField: false,
						streamField: false,
					},
					{
						field: "actions",
						description: "Exactly one action name.",
						type: "array",
						items: { description: "One action name" },
						required: true,
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.ACTION_PLANNER,
					preferredEncapsulation: "toon",
					maxRetries: 1,
				},
			});

			if (actionOnlyRescue) {
				const rescuedActions = normalizePlannerActions(
					actionOnlyRescue as Record<string, unknown>,
					runtime,
				);
				if (
					rescuedActions.some(
						(actionName) =>
							!PROVIDER_FOLLOWUP_PASSIVE_ACTIONS.has(
								normalizeActionIdentifier(actionName),
							),
					)
				) {
					runtime.logger.info(
						{
							src: "service:message",
							originalActions: responseContent.actions ?? [],
							rescuedActions,
						},
						"Recovered primary action after passive reply draft",
					);
					responseContent.actions = rescuedActions;
				}
			}
		}

		if (shouldRunMetadataActionRescue(responseContent)) {
			const metadataSuggestion = suggestOwnedActionFromMetadata(
				runtime,
				message,
			);
			if (metadataSuggestion) {
				runtime.logger.info(
					{
						src: "service:message",
						originalActions: responseContent.actions ?? [],
						suggestedAction: metadataSuggestion.actionName,
						score: metadataSuggestion.score,
						secondBestScore: metadataSuggestion.secondBestScore,
						reasons: metadataSuggestion.reasons,
					},
					"Recovered primary action from action metadata after passive reply draft",
				);
				responseContent.actions = [metadataSuggestion.actionName];
			}
		}

		// Action parameter repair (Python parity):
		// If the model selected actions with missing or invalid params, do a
		// second pass asking for ONLY corrected TOON params.
		const actionByName = new Map<string, Action>();
		for (const action of runtime.actions) {
			const normalizedName = action.name.trim().toUpperCase();
			if (normalizedName) {
				actionByName.set(normalizedName, action);
			}
		}

		const metadataCorrection = findOwnedActionCorrectionFromMetadata(
			runtime,
			message,
			responseContent,
		);
		if (metadataCorrection) {
			runtime.logger.info(
				{
					src: "service:message",
					originalActions: responseContent.actions ?? [],
					suggestedAction: metadataCorrection.actionName,
					score: metadataCorrection.score,
					secondBestScore: metadataCorrection.secondBestScore,
					reasons: metadataCorrection.reasons,
				},
				"Corrected routed action from action metadata",
			);
			responseContent.actions = [metadataCorrection.actionName];
		}

		const collectParameterValidationIssues = (
			paramsByAction: Map<string, ActionParameters>,
		): Array<{
			actionName: string;
			required: string[];
			errors: string[];
		}> => {
			const issues: Array<{
				actionName: string;
				required: string[];
				errors: string[];
			}> = [];
			for (const selectedAction of responseContent.actions ?? []) {
				const actionName =
					typeof selectedAction === "string"
						? selectedAction.trim().toUpperCase()
						: "";
				if (!actionName) {
					continue;
				}
				const actionDef = actionByName.get(actionName);
				if (!actionDef?.parameters?.length) {
					continue;
				}
				const validation = validateActionParams(
					actionDef,
					paramsByAction.get(actionName),
				);
				if (validation.valid) {
					continue;
				}
				issues.push({
					actionName,
					required: actionDef.parameters
						.filter((parameter) => parameter.required)
						.map((parameter) => parameter.name),
					errors: validation.errors,
				});
			}
			return issues;
		};

		let existingParams = parseActionParams(responseContent.params);
		let parameterValidationIssues =
			collectParameterValidationIssues(existingParams);

		if (parameterValidationIssues.length > 0) {
			const requirementLines = parameterValidationIssues
				.map(({ actionName, required, errors }) =>
					[
						`- ${actionName}`,
						required.length > 0
							? `  required: ${required.join(", ")}`
							: "  required: (none)",
						...errors.map((error) => `  error: ${error}`),
					].join("\n"),
				)
				.join("\n");
			const existingParamBlock =
				typeof responseContent.params === "string" &&
				responseContent.params.trim().length > 0
					? responseContent.params.trim()
					: "(none)";
			const repairPrompt = [
				prompt,
				"",
				"# Parameter Repair",
				"You selected actions whose params are missing or invalid.",
				"Return ONLY TOON with a top-level params object that fixes those actions.",
				"Do not change the selected actions.",
				"Example:",
				"params:",
				"  SEND_MESSAGE:",
				"    target: room-or-channel-id",
				"    text: message body",
				"",
				"Current params:",
				existingParamBlock,
				"",
				"Issues by action:",
				requirementLines,
				"",
				"Do not include thought, actions, providers, text, or any other fields.",
			].join("\n");

			const repairParsed = await runtime.dynamicPromptExecFromState({
				state,
				params: {
					prompt: repairPrompt,
				},
				schema: [
					{
						field: "params",
						description:
							"TOON object keyed by action name containing corrected action params",
						type: "object",
						required: true,
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.TEXT_LARGE,
					preferredEncapsulation: "toon",
					contextCheckLevel: 0,
					maxRetries: 1,
				},
			});
			if (repairParsed?.params) {
				responseContent.params = repairParsed.params as Content["params"];
				existingParams = parseActionParams(responseContent.params);
				parameterValidationIssues =
					collectParameterValidationIssues(existingParams);
			}
		}

		if (parameterValidationIssues.length > 0) {
			runtime.logger.warn(
				{
					src: "service:message",
					issues: parameterValidationIssues,
				},
				"Planner response still has invalid action params after repair pass",
			);
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
			responseContent.actions = stripReplyWhenActionOwnsTurn(
				runtime,
				responseContent.actions,
			);
			// Suppress any direct planner answer; the REPLY action should generate final output.
			if (responseContent.actions.some((a) => isReplyActionIdentifier(a))) {
				responseContent.text = "";
			}
		}

		// LLM terminal-control ambiguity handling
		if (responseContent.actions && responseContent.actions.length > 1) {
			responseContent.actions = stripReplyWhenActionOwnsTurn(
				runtime,
				responseContent.actions,
			);
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

		const mode = resolveStrategyMode(responseContent);
		responseContent.simple = mode === "simple";
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
			mode,
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
			message,
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
		// Short-circuit when no LLM provider is configured at all. The fallback
		// model loop below would just throw `NoModelProviderConfiguredError` for
		// every model type and surface a misleading generic failure to the user.
		// Instead, render an actionable hint directly. See elizaOS/eliza#7203.
		if (!hasTextGenerationHandler(runtime)) {
			return this.buildNoModelProviderReply(
				runtime,
				message,
				state,
				responseId,
				stage,
			);
		}

		const recentMessages =
			typeof state.values?.recentMessages === "string" &&
			state.values.recentMessages.trim().length > 0
				? state.values.recentMessages
				: typeof state.text === "string" && state.text.trim().length > 0
					? state.text
					: typeof message.content.text === "string"
						? message.content.text
						: "(unavailable)";
		const failurePrompt = [
			"You hit a transient model error and have to send a short user-facing reply.",
			"Write a one or two sentence reply in plain language.",
			"",
			"Hard rules:",
			"- Stay in character. Keep your usual voice and tone.",
			"- NEVER mention internal mechanism words such as: planner, action_planner,",
			"  XML, TOON, JSON, schema, structured output, model, retries, sonnet,",
			"  opus, claude, anthropic, prompt, parse, parser, xml plan, decision",
			"  loop, runtime, dispatch, or hand off. The user does not know or care",
			"  what those are.",
			"- Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
			"- Just acknowledge that something went wrong and suggest a retry.",
			'  Examples: "something flaked, try again in a sec",',
			'  "weird hiccup, give me another shot in a moment",',
			'  "got stuck on my end, retry that?"',
			"- If the user already gave a clear command and you can plausibly act,",
			"  acknowledge it and offer to take the action directly. Keep it short.",
			"- Return only the reply text. No labels, no XML, no JSON, no <think>.",
			"",
			"Recent Conversation:",
			recentMessages,
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
					/^TOON\b/i.test(cleaned) || /^(thought|text)\s*:/i.test(cleaned);
				const parsed = looksStructuredReply
					? parseToonKeyValue<{ text?: string }>(cleaned)
					: null;
				replyText =
					typeof parsed?.text === "string" && parsed.text.trim().length > 0
						? parsed.text.trim()
						: cleaned;
				if (replyText) {
					break;
				}
			} catch (error) {
				// If the runtime reports no LLM provider is configured at all,
				// no further model attempts will succeed. Surface the actionable
				// hint instead of the generic transient-failure message. See
				// elizaOS/eliza#7203.
				if (
					error instanceof Error &&
					error.name === "NoModelProviderConfiguredError"
				) {
					return this.buildNoModelProviderReply(
						runtime,
						message,
						state,
						responseId,
						stage,
					);
				}
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
			// Last-ditch fallback when every model call above also failed.
			// Voice-neutral so any character can ship this default; characters
			// can override with their own phrasing via
			// character.templates.transientFailureReply.
			replyText =
				runtime.character.templates?.transientFailureReply ||
				"Something went wrong on my end. Please try again.";
		}

		replyText = truncateToCompleteSentence(replyText.trim(), 2000);

		const responseContent: Content = {
			thought: `Handle a temporary reply failure during ${stage}.`,
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
	 * Render the no-LLM-provider hint as a chat reply. Used when `useModel`
	 * throws `NoModelProviderConfiguredError`, which means no provider plugin
	 * is registered and no fallback model call will ever succeed. The user
	 * sees an actionable message instead of a generic transient-failure
	 * template. See elizaOS/eliza#7203.
	 */
	private buildNoModelProviderReply(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		responseId: UUID,
		stage: string,
	): StrategyResult {
		const replyText =
			runtime.character.templates?.noModelProviderReply ||
			"This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).";

		runtime.logger.warn(
			{ src: "service:message", stage },
			"No LLM provider configured; rendering setup hint reply",
		);

		const responseContent: Content = {
			thought: `No LLM provider configured during ${stage}.`,
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
			accumulatedState = withActionResults(
				accumulatedState,
				traceActionResult,
			) as MultiStepState;

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
					traceActionResult.push(
						preparePromptActionResult(runtime, message, {
							data: { actionName: providerName },
							success,
							text,
							error,
						}),
					);

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

				await invokeOnBeforeActionExecution(opts, runtime, message);
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

				// Break the multi-step loop when the action returned a terminal
				// "needs human confirmation" signal. Without this, actions that
				// return { requiresConfirmation: true } cause the planner to
				// re-fire the same plan every iteration. Confirmation must come
				// from the next user message — there is nothing the agent can
				// do to supply it on its own.
				const resultValuesForConfirm =
					result &&
					"values" in result &&
					typeof result.values === "object" &&
					result.values !== null
						? (result.values as Record<string, unknown>)
						: null;
				const resultDataForConfirm =
					result &&
					"data" in result &&
					typeof result.data === "object" &&
					result.data !== null
						? (result.data as Record<string, unknown>)
						: null;
				// Recognize any confirmation-required signal an action might use:
				// the canonical `requiresConfirmation: true` flag (in either values
				// or data) plus the typed `ActionConfirmationStatus` codes that
				// handlers may set on `error`. The set is owned by
				// `types/components.ts` so callers cannot drift.
				const requiresConfirmation =
					resultValuesForConfirm?.requiresConfirmation === true ||
					resultDataForConfirm?.requiresConfirmation === true ||
					isActionConfirmationStatus(resultValuesForConfirm?.error) ||
					isActionConfirmationStatus(resultDataForConfirm?.error);
				if (requiresConfirmation) {
					runtime.logger.info(
						{
							src: "service:message",
							agentId: runtime.agentId,
							iteration: iterationCount,
							action,
						},
						"Action returned requiresConfirmation — terminating multi-step loop until next user message",
					);
					break;
				}
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
		accumulatedState = withActionResults(
			accumulatedState,
			traceActionResult,
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
				preferredEncapsulation: "toon",
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

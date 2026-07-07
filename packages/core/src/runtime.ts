/**
 * The `AgentRuntime` — the central orchestrator every Eliza agent runs on, and
 * the concrete `implements IAgentRuntime`. One instance owns a single agent's
 * whole world: its actions, providers, evaluators, and services; the
 * model-handler registry and the `useModel` dispatch/routing/fallback layer; the
 * plugin set and its lifecycle (register / unload / reload / config); memory and
 * state (database adapter, embeddings, `stateCache`, working memory); and the
 * message loop that runs provider -> model -> action -> evaluator. Plugins
 * contribute capabilities; the runtime wires and runs them, and nearly all of
 * `@elizaos/core` and every plugin ultimately talks to this class.
 *
 * The file is ~10k lines — navigate by symbol, never top-to-bottom. Alongside the
 * class it exports typed boot errors (`NoModelProviderConfiguredError`,
 * `EmbeddingDimensionProbeError`) that `initialize()` treats specially.
 *
 * Invariants to preserve when editing:
 * - `getSetting()` resolves per-agent config and DELIBERATELY never reads
 *   `process.env` — in a multi-tenant process that would leak a host secret into
 *   every agent; hosts fold dotenv into the constructor `settings` map instead.
 * - Embedding width is pinned to whichever TEXT_EMBEDDING provider answered the
 *   boot dimension probe; a later embedding from a different provider can emit a
 *   width the SQL adapter silently drops (#8769). If every provider fails the
 *   probe, `initialize()` catches `EmbeddingDimensionProbeError` non-fatally and
 *   disables embedding generation instead of crashing boot.
 * - Without a database adapter, `initialize()` falls back to the in-memory
 *   adapter only when `ALLOW_NO_DATABASE` is set.
 */
import Handlebars from "handlebars";
import { v4 as uuidv4 } from "uuid";
import {
	withCanonicalActionDocs,
	withCanonicalProviderDocs,
} from "./action-docs";
import { ensureConnection as ensureConnectionStandalone } from "./connection";
import { registerConnectorSourceDefinitions } from "./connectors";
import { deriveKnownSecrets } from "./constants/secrets";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { ElizaError, type ReportedError, toElizaError } from "./errors";
import {
	type CapabilityConfig,
	type CapabilitySettingFlags,
	createBasicCapabilitiesPlugin,
	resolveCapabilityConfig,
} from "./features/basic-capabilities/index";
import {
	INFERENCE_MARKS,
	markInference,
	recordInferenceSpan,
	setInferenceModelProvider,
} from "./inference-timing";
import { createLogger } from "./logger";
import { simpleHash } from "./optimization/ab-analysis";
import { getOptimizationRootDir } from "./optimization-root-dir";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle";
import { createCoreSecurityHooksPlugin } from "./plugins/core-security-hooks";
import {
	getNativeRuntimeFeaturePlugin,
	type NativeRuntimeFeature,
	nativeRuntimeFeatureDefaults,
	nativeRuntimeFeaturePluginNames,
	resolveNativeRuntimeFeatureFromPluginName,
	resolveNativeRuntimeFeatureFromServiceType,
} from "./plugins/native-features";
import {
	executeChainWithFallback,
	isLocalHandler,
	maybeReroute,
	resolveChain,
} from "./runtime/action-model-routing";
import { getActionRolePolicyWarnings } from "./runtime/action-role-policy";
import {
	getActionRoutingContext,
	runWithActionRoutingContext,
	runWithoutActionRoutingContext,
} from "./runtime/action-routing-context";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "./runtime/builtin-field-evaluators";
import { ChatPreHandlerRegistry } from "./runtime/chat-pre-handler-registry";
import { ContextRegistry } from "./runtime/context-registry";
import { DEFAULT_CONTEXT_DEFINITIONS } from "./runtime/default-contexts";
import {
	findEquivalentFact,
	mergeStrongerFactMetadata,
} from "./runtime/fact-write-dedupe";
import type { ResponseHandlerEvaluator } from "./runtime/response-handler-evaluators";
import type { ResponseHandlerFieldEvaluator } from "./runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "./runtime/response-handler-field-registry";
import { RoomHandlerQueue } from "./runtime/room-handler-queue";
import { ShortcutRegistry } from "./runtime/shortcut-registry";
import {
	buildCanonicalSystemPrompt,
	resolveEffectiveSystemPrompt,
	textFromChatMessageContent,
} from "./runtime/system-prompt";
import { buildProviderAttributionsFromState } from "./runtime/trajectory-provider-attribution";
import { TurnControllerRegistry } from "./runtime/turn-controller";
import { BM25 } from "./search";
import {
	CompositeEntityRecognizer,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	PII_ENTITY_RECOGNIZER_SERVICE,
	PII_SWAP_DISABLED_KINDS_SETTING,
	PII_SWAP_ENABLED_SETTING,
	PII_SWAP_EXEMPT_VALUES_SETTING,
	type PiiEntityRecognizer,
	type PiiEntityRecognizerService,
	PseudonymSession,
	parsePiiSwapList,
	RegexEntityRecognizer,
} from "./security/index.js";
import { redactWithSecrets } from "./security/redact.js";
import {
	parseSecretSwapExemptValues,
	SECRET_SWAP_ENABLED_SETTING,
	SECRET_SWAP_EXEMPT_VALUES_SETTING,
	SecretSwapSession,
} from "./security/secret-swap";
import { DefaultMessageService } from "./services/message";
import {
	describeModelCallError,
	isModelProviderFallbackError,
} from "./services/message/fallback-reply";
import { ensureAgentVoice } from "./services/message/voice-gate";
import type { TaskService } from "./services/task";
import type { ToolPolicyService } from "./services/tool-policy";
import { decryptSecret, getSalt } from "./settings";
import {
	getStreamingContext,
	runInsideModelStreamChunkDelivery,
	runWithStreamingContext,
} from "./streaming-context";
import {
	getTrajectoryContext,
	setTrajectoryPurpose,
} from "./trajectory-context";
import {
	type TrajectoryProviderAccessLogger,
	type TrajectoryRuntimeLlmCallLogger,
	withProviderStep,
} from "./trajectory-utils";
import {
	type AccessContext,
	type Action,
	type ActionMode,
	type ActionResult,
	type Agent,
	type AppendConnectorAccountAuditEventParams,
	assertPublicRouteIntent,
	ChannelType,
	type Character,
	type Component,
	type ConnectorAccountAuditEventRecord,
	type ConnectorAccountCredentialRefRecord,
	type ConnectorAccountRecord,
	type ConnectorAccountRef,
	type ConnectorPostIdentity,
	type ConsumeOAuthFlowStateParams,
	type Content,
	type ControlMessage,
	type CreateOAuthFlowStateParams,
	type DeleteConnectorAccountParams,
	type DeleteOAuthFlowStateParams,
	type Entity,
	type EventHandler,
	type EventPayload,
	type EventPayloadMap,
	EventType,
	type GenerateTextOptions,
	type GenerateTextParams,
	type GenerateTextResult,
	type GetConnectorAccountCredentialRefParams,
	type GetConnectorAccountParams,
	type GetOAuthFlowStateParams,
	getModelFallbackChain,
	type HandlerCallback,
	type IAgentRuntime,
	type IDatabaseAdapter,
	type IMessagingAdapter,
	type JsonValue,
	type ListConnectorAccountCredentialRefsParams,
	type ListConnectorAccountsParams,
	type Log,
	type LogBody,
	type Memory,
	type MemoryMetadata,
	type MessageConnector,
	type MessageConnectorCreateThreadParams,
	type MessageConnectorMetadata,
	type MessageConnectorRegistration,
	type MessageSearchHit,
	type Metadata,
	type ModelHandler,
	type ModelParamsMap,
	type ModelRegistrationInfo,
	type ModelRegistrationMetadata,
	type ModelResultMap,
	ModelType,
	type ModelTypeName,
	type OAuthFlowRecord,
	type PairingAllowlistEntry,
	type PairingChannel,
	type PairingRequest,
	type Participant,
	type PatchOp,
	type PipelineHookContext,
	type PipelineHookPhase,
	type PipelineHookSpec,
	type Plugin,
	type PluginOwnership,
	type PostConnector,
	type PostConnectorMetadata,
	type PostConnectorRegistration,
	type PromptSegment,
	type Provider,
	type ProviderResult,
	type ProviderValue,
	type RegisteredEvaluator,
	type Relationship,
	type RemotePluginInstallOptions,
	type RemotePluginInstanceHandle,
	type ResolvedPipelineHook,
	type ResponseSkeleton,
	type Room,
	type Route,
	type RuntimeEventStorage,
	type RuntimeSettings,
	type RuntimeStopOptions,
	type SendHandlerFunction,
	type Service,
	type ServiceClass,
	ServiceType,
	type ServiceTypeName,
	type SetConnectorAccountCredentialRefParams,
	type State,
	type StateValue,
	type StreamChunkCallback,
	type TargetInfo,
	type Task,
	type TaskWorker,
	TEXT_GENERATION_MODEL_TYPES,
	type TextGenerationModelType,
	type TextStreamResult,
	type ThreadHandle,
	type UpdateOAuthFlowStateParams,
	type UpsertConnectorAccountParams,
	type UUID,
	type World,
} from "./types";
import type {
	ChatPreHandler,
	ChatPreHandlerContext,
	ChatPreHandlerResult,
} from "./types/chat-pre-handler";
import type { AgentContext } from "./types/contexts";
import type { IMessageService } from "./types/message-service";
import {
	afterMemoryPersistedPipelineHookContext,
	composeStateProvidersPipelineHookContext,
	modelStreamChunkPipelineHookContext,
	modelStreamEndPipelineHookContext,
	PIPELINE_HOOK_DEBUG_LOG_MS,
	PIPELINE_HOOK_ERROR_LOG_MS,
	PIPELINE_HOOK_WARN_MS,
	pipelineHookMetricRoomId,
	postModelPipelineHookContext,
	preModelPipelineHookContext,
	resolvePipelineHookSpec,
	sortPipelineHooksByPosition,
} from "./types/pipeline-hooks";
import type { PromptOptimizationRuntimeHooks } from "./types/prompt-optimization-hooks";
import { ScoreCard } from "./types/prompt-optimization-score-card";
import type {
	ExecutionTrace,
	ScoreSignal,
} from "./types/prompt-optimization-trace";
import {
	type SearchCategoryEnumerationOptions,
	type SearchCategoryLookupOptions,
	type SearchCategoryRegistration,
	SearchCategoryRegistryError,
} from "./types/search";
import type { ShortcutDefinition } from "./types/shortcut";
import type {
	RetryBackoffConfig,
	SchemaRow,
	SchemaValueSpec,
	StreamEvent,
	StructuredOutputFailure,
} from "./types/state";
import type { ToolPolicyConfig, ToolProfileId } from "./types/tools";
import { parseJSONObjectFromText, stringToUuid } from "./utils";
import { parseBooleanValue } from "./utils/boolean";
import { BufferUtils } from "./utils/buffer";
import { resolveProviderContexts } from "./utils/context-catalog";
import {
	getActiveRoutingContextsForTurn,
	shouldIncludeByContext,
} from "./utils/context-routing";
import { buildDeterministicSeed } from "./utils/deterministic";
import { getNumberEnv } from "./utils/environment";
import { getErrorMessage, isTransientModelError } from "./utils/model-errors";
import { captureModelLookupCaller } from "./utils/model-lookup-caller";
import { PromptBatcher, PromptDispatcher } from "./utils/prompt-batcher";
import {
	ResponseSkeletonStreamExtractor,
	StructuredFieldStreamExtractor,
} from "./utils/streaming";
import { isPlainObject } from "./utils/type-guards";

const environmentSettings: RuntimeSettings = {};
// Whether debug-level logs are emitted, captured once at load (mirrors the
// logger's static LOG_LEVEL read; debug is on only for trace/verbose/debug).
// Lets hot paths skip building expensive debug-only payloads. Guarded for the
// browser/edge build targets where `process` is absent.
const RUNTIME_DEBUG_LOG_ENABLED =
	typeof process !== "undefined" &&
	["trace", "verbose", "debug"].includes(
		String(process.env?.LOG_LEVEL || "info").toLowerCase(),
	);
const RUNTIME_TEMPLATE_CACHE = new Map<
	string,
	Handlebars.TemplateDelegate<Record<string, unknown>>
>();
const RUNTIME_TEMPLATE_CACHE_LIMIT = 256;
const DEFAULT_SERVICE_START_SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_FAST_SERVICE_STOP_TIMEOUT_MS = 500;
// stateCache holds up to 2 entries per message (base State + `${id}_action_results`).
// Previously it was never unconditionally evicted at end-of-turn, so a long-lived
// runtime accumulated one State per processed message for its lifetime (~4.7 KB/msg,
// ~23 MB at 5k messages). Cap it; oldest entries evict once over the cap, which keeps
// recent and in-flight turns while bounding memory.
const STATE_CACHE_LIMIT = 512;
const PROVIDERS_PROMPT_MARKER = "__ELIZA_PROMPT_SEGMENT_PROVIDERS__";
const COMPOSE_STATE_PROVIDER_TIMEOUT_MS = 30_000;
const STABLE_PROMPT_TEMPLATE_KEYS = new Set([
	"agentName",
	"bio",
	"system",
	"topic",
	"topics",
	"adjective",
	"messageDirections",
	"postDirections",
	"directions",
	"examples",
	"characterPostExamples",
	"characterMessageExamples",
	"actionNames",
	"actionsWithDescriptions",
	"providersWithDescriptions",
]);
const STABLE_PROMPT_PROVIDER_NAMES = new Set([
	"ACTIONS",
	"CHARACTER",
	"PROVIDERS",
]);
const STRUCTURED_CODE_FENCE_PATTERN = /```([^\n`]*)\r?\n?([\s\S]*?)```/g;
const JSON_OBJECT_KEY_PATTERN =
	/(?:["'][^"'\n]+["']|[A-Za-z_][A-Za-z0-9_-]*)\s*:/;

/**
 * Thrown by `AgentRuntime.useModel` when a text-generation model is requested
 * but no LLM provider plugin is registered for any text model type at all.
 *
 * This is distinct from "one provider is registered but the specific type is
 * missing" — that case still throws the generic `No handler found for delegate
 * type` error so legitimate misconfigurations stay loud.
 *
 * Surfacing this as a typed error lets the chat layer render an actionable
 * hint instead of a generic parse-failure template. See issue elizaOS/eliza#7203.
 */
export class NoModelProviderConfiguredError extends Error {
	constructor(
		message: string = "This agent has no LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY in your environment, or sign in to Eliza Cloud (ELIZAOS_CLOUD_API_KEY).",
	) {
		super(message);
		this.name = "NoModelProviderConfiguredError";
	}
}

/** One failed TEXT_EMBEDDING dimension-probe attempt, kept for diagnostics. */
export interface EmbeddingProbeAttempt {
	provider: string;
	modelKey: string;
	error: string;
}

/**
 * Thrown by `AgentRuntime.ensureEmbeddingDimension` when EVERY registered
 * TEXT_EMBEDDING provider failed the null dimension probe. Carries the
 * per-provider failure list so callers (and logs) can show exactly which
 * providers were tried and why each one failed.
 *
 * `AgentRuntime.initialize` catches this error type — and only this type —
 * non-fatally: the runtime keeps booting with embedding generation disabled
 * (memory writes persist without vectors) instead of either crashing boot or
 * leaving the vector column at its default width, where later real vectors
 * would be silently dropped on dimension mismatch by the SQL adapter (#8769).
 */
export class EmbeddingDimensionProbeError extends Error {
	readonly attempts: readonly EmbeddingProbeAttempt[];
	constructor(attempts: readonly EmbeddingProbeAttempt[]) {
		const detail = attempts
			.map((attempt) => `${attempt.provider}: ${attempt.error}`)
			.join("; ");
		super(
			`All ${attempts.length} registered TEXT_EMBEDDING provider(s) failed the embedding dimension probe — ${detail}`,
		);
		this.name = "EmbeddingDimensionProbeError";
		this.attempts = attempts;
	}
}

const TEXT_GENERATION_MODEL_KEYS: readonly string[] =
	TEXT_GENERATION_MODEL_TYPES;

type StructuredResponseFormat = "JSON" | "TOON";

type StructuredResponseCandidate = {
	text: string;
	formats: StructuredResponseFormat[];
	source: string;
};

type DynamicPromptStreamExtractor = {
	push(chunk: string): void;
	flush(): void;
	reset(): void;
	signalError(message: string): void;
	signalRetry(retry: number): { validatedFields: string[] };
	diagnose(): {
		missingFields: string[];
		invalidFields: string[];
		incompleteFields: string[];
	};
	getValidatedFields(): Map<string, string>;
};

function coerceOutgoingMessageText(text: unknown): string {
	if (text === null || text === undefined) {
		return "";
	}
	return String(text);
}

function stringifyStructuredForPrompt(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function resolveDynamicPromptModelType(
	modelType?: TextGenerationModelType,
	modelSize?: "nano" | "small" | "medium" | "large" | "mega",
): TextGenerationModelType {
	if (modelType) {
		return modelType;
	}

	switch (modelSize) {
		case "nano":
			return ModelType.TEXT_NANO;
		case "small":
			return ModelType.TEXT_SMALL;
		case "medium":
			return ModelType.TEXT_MEDIUM;
		case "mega":
			return ModelType.TEXT_MEGA;
		default:
			return ModelType.TEXT_LARGE;
	}
}

/**
 * Resolves the default structured-output format from a setting value.
 * Used by `dynamicPromptExecFromState` when no per-call preference is given.
 */
export function resolveDefaultOutputFormat(
	raw: unknown,
): StructuredResponseFormat {
	if (typeof raw !== "string") return "JSON";
	switch (raw.trim().toLowerCase()) {
		case "json":
			return "JSON";
		default:
			return "JSON";
	}
}

const DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS = new Set(["text"]);
const DEFAULT_RESPONSE_SKELETON_STREAM_FIELDS = new Set([
	"replyText",
	"text",
	"messageToUser",
]);

/**
 * Resolve which structured fields stream to the consumer for the line-oriented
 * `dynamicPromptExecFromState` path. A field streams when it opts in with
 * `streamField: true`, or — when it expresses no preference — when its name is
 * in {@link DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS} (the clean reply `text`).
 * `streamField: false` always opts out. Exported for regression coverage of
 * the default token-stream contract (#9174).
 */
export function resolveDynamicPromptStreamFields(
	schema: readonly SchemaRow[],
): string[] {
	return schema
		.filter((row) => {
			if (row.streamField === true) {
				return true;
			}
			if (row.streamField === false) {
				return false;
			}
			return DEFAULT_DYNAMIC_PROMPT_STREAM_FIELDS.has(row.field);
		})
		.map((row) => row.field);
}

function resolveResponseSkeletonStreamFields(
	skeleton: ResponseSkeleton | undefined,
): string[] {
	if (!skeleton) {
		return [];
	}
	const fields: string[] = [];
	const seen = new Set<string>();
	for (const span of skeleton.spans) {
		const key = span.key;
		if (
			span.kind === "free-string" &&
			key &&
			DEFAULT_RESPONSE_SKELETON_STREAM_FIELDS.has(key) &&
			!seen.has(key)
		) {
			seen.add(key);
			fields.push(key);
		}
	}
	return fields;
}

type ServiceResolver = (service: Service) => void;
type ServiceRejecter = (reason: Error | string) => void;
type ServicePromiseHandler = {
	resolve: ServiceResolver;
	reject: ServiceRejecter;
};

function isTextStreamResult(
	value: JsonValue | object,
): value is TextStreamResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"textStream" in value &&
		"text" in value &&
		"usage" in value &&
		"finishReason" in value
	);
}

function getSearchCategoryKey(category: string): string {
	return category.trim().toLowerCase();
}

function cloneSearchCategoryRegistration(
	registration: SearchCategoryRegistration,
): SearchCategoryRegistration {
	return {
		...registration,
		contexts: registration.contexts ? [...registration.contexts] : undefined,
		filters: registration.filters?.map((filter) => ({
			...filter,
			options: filter.options?.map((option) => ({ ...option })),
		})),
		capabilities: registration.capabilities
			? [...registration.capabilities]
			: undefined,
	};
}

function normalizeSearchCategoryRegistration(
	registration: SearchCategoryRegistration,
): SearchCategoryRegistration {
	const category =
		typeof registration.category === "string"
			? registration.category.trim()
			: "";
	const label =
		typeof registration.label === "string" ? registration.label.trim() : "";
	if (!category) {
		throw new Error("Search category registration requires a category");
	}
	if (!label) {
		throw new Error("Search category registration requires a label");
	}
	return cloneSearchCategoryRegistration({
		...registration,
		category,
		label,
		enabled: registration.enabled ?? true,
	});
}

function labelFromMessageConnectorSource(source: string): string {
	const label = source
		.replace(/[_-]+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
	return label || "Message Connector";
}

const CONNECTOR_ACCOUNT_KEY_SEPARATOR = "\u0000";

function normalizeConnectorAccountId(accountId: unknown): string | undefined {
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

function connectorRouteKey(source: string, accountId?: string): string {
	return accountId
		? `${source}${CONNECTOR_ACCOUNT_KEY_SEPARATOR}${accountId}`
		: source;
}

function connectorKeySource(key: string): string {
	return key.split(CONNECTOR_ACCOUNT_KEY_SEPARATOR, 1)[0] ?? key;
}

function cloneConnectorAccountRef(
	account: ConnectorAccountRef,
	source: string,
): ConnectorAccountRef {
	return {
		...account,
		source: account.source || source,
		accountId: normalizeConnectorAccountId(account.accountId),
		capabilities: account.capabilities
			? account.capabilities.map((capability) => ({
					...capability,
					targetKinds: capability.targetKinds
						? [...capability.targetKinds]
						: undefined,
					scopes: capability.scopes ? [...capability.scopes] : undefined,
					metadata: capability.metadata
						? { ...capability.metadata }
						: undefined,
				}))
			: undefined,
		metadata: account.metadata ? { ...account.metadata } : undefined,
	};
}

function normalizeConnectorAccountRef(
	source: string,
	account?: ConnectorAccountRef,
	accountId?: string,
): ConnectorAccountRef | undefined {
	const normalizedAccountId =
		normalizeConnectorAccountId(accountId) ??
		normalizeConnectorAccountId(account?.accountId);
	if (!account && !normalizedAccountId) {
		return undefined;
	}
	return cloneConnectorAccountRef(
		{
			...account,
			source: account?.source?.trim() || source,
			accountId: normalizedAccountId,
		},
		source,
	);
}

function cloneMessageConnector(connector: MessageConnector): MessageConnector {
	return {
		...connector,
		account: connector.account
			? cloneConnectorAccountRef(connector.account, connector.source)
			: undefined,
		capabilities: [...connector.capabilities],
		supportedTargetKinds: [...connector.supportedTargetKinds],
		contexts: [...connector.contexts],
		metadata: connector.metadata ? { ...connector.metadata } : undefined,
		contentShaping: connector.contentShaping
			? {
					...connector.contentShaping,
					constraints: connector.contentShaping.constraints
						? { ...connector.contentShaping.constraints }
						: undefined,
				}
			: undefined,
	};
}

function clonePostConnector(connector: PostConnector): PostConnector {
	return {
		...connector,
		account: connector.account
			? cloneConnectorAccountRef(connector.account, connector.source)
			: undefined,
		capabilities: [...connector.capabilities],
		contexts: [...connector.contexts],
		metadata: connector.metadata ? { ...connector.metadata } : undefined,
		contentShaping: connector.contentShaping
			? {
					...connector.contentShaping,
					constraints: connector.contentShaping.constraints
						? { ...connector.contentShaping.constraints }
						: undefined,
				}
			: undefined,
	};
}

function normalizeMessageConnector(
	source: string,
	metadata: MessageConnectorMetadata = {},
): MessageConnector {
	const accountId =
		normalizeConnectorAccountId(metadata.accountId) ??
		normalizeConnectorAccountId(metadata.account?.accountId);
	const connector: MessageConnector = {
		source,
		accountId,
		account: normalizeConnectorAccountRef(source, metadata.account, accountId),
		label: metadata.label?.trim() || labelFromMessageConnectorSource(source),
		capabilities: metadata.capabilities
			? [...metadata.capabilities]
			: ["send_message"],
		supportedTargetKinds: metadata.supportedTargetKinds
			? [...metadata.supportedTargetKinds]
			: [],
		contexts: metadata.contexts ? [...metadata.contexts] : [],
	};

	if (metadata.description) connector.description = metadata.description;
	if (metadata.metadata) connector.metadata = { ...metadata.metadata };
	if (metadata.resolveTargets)
		connector.resolveTargets = metadata.resolveTargets;
	if (metadata.listRecentTargets)
		connector.listRecentTargets = metadata.listRecentTargets;
	if (metadata.listRooms) connector.listRooms = metadata.listRooms;
	if (metadata.getChatContext)
		connector.getChatContext = metadata.getChatContext;
	if (metadata.getUserContext)
		connector.getUserContext = metadata.getUserContext;
	if (metadata.listServers) connector.listServers = metadata.listServers;
	if (metadata.fetchMessages) connector.fetchMessages = metadata.fetchMessages;
	if (metadata.searchMessages)
		connector.searchMessages = metadata.searchMessages;
	if (metadata.reactHandler) connector.reactHandler = metadata.reactHandler;
	if (metadata.editHandler) connector.editHandler = metadata.editHandler;
	if (metadata.deleteHandler) connector.deleteHandler = metadata.deleteHandler;
	if (metadata.pinHandler) connector.pinHandler = metadata.pinHandler;
	if (metadata.joinHandler) connector.joinHandler = metadata.joinHandler;
	if (metadata.leaveHandler) connector.leaveHandler = metadata.leaveHandler;
	if (metadata.getUser) connector.getUser = metadata.getUser;
	if (metadata.typingHandler) connector.typingHandler = metadata.typingHandler;
	if (metadata.stopTypingHandler)
		connector.stopTypingHandler = metadata.stopTypingHandler;
	if (metadata.createThreadHandler)
		connector.createThreadHandler = metadata.createThreadHandler;
	if (metadata.postToThreadHandler)
		connector.postToThreadHandler = metadata.postToThreadHandler;
	if (metadata.contentShaping)
		connector.contentShaping = {
			...metadata.contentShaping,
			constraints: metadata.contentShaping.constraints
				? { ...metadata.contentShaping.constraints }
				: undefined,
		};

	return connector;
}

function normalizePostConnector(
	source: string,
	metadata: PostConnectorMetadata = {},
): PostConnector {
	const accountId =
		normalizeConnectorAccountId(metadata.accountId) ??
		normalizeConnectorAccountId(metadata.account?.accountId);
	const connector: PostConnector = {
		source,
		accountId,
		account: normalizeConnectorAccountRef(source, metadata.account, accountId),
		label: metadata.label?.trim() || labelFromMessageConnectorSource(source),
		capabilities: metadata.capabilities ? [...metadata.capabilities] : ["post"],
		contexts: metadata.contexts ? [...metadata.contexts] : [],
	};

	if (metadata.description) connector.description = metadata.description;
	if (metadata.metadata) connector.metadata = { ...metadata.metadata };
	if (metadata.postHandler) connector.postHandler = metadata.postHandler;
	if (metadata.fetchFeed) connector.fetchFeed = metadata.fetchFeed;
	if (metadata.searchPosts) connector.searchPosts = metadata.searchPosts;
	if (metadata.contentShaping)
		connector.contentShaping = {
			...metadata.contentShaping,
			constraints: metadata.contentShaping.constraints
				? { ...metadata.contentShaping.constraints }
				: undefined,
		};

	return connector;
}

function getServiceClassLabel(serviceClass: ServiceClass): string {
	return (
		(serviceClass as { name?: string }).name ||
		serviceClass.constructor.name ||
		"anonymous service class"
	);
}

function isMessagingAdapter(
	adapter: IDatabaseAdapter,
): adapter is IDatabaseAdapter & IMessagingAdapter {
	const candidate = adapter as Partial<IMessagingAdapter>;
	return (
		typeof candidate.createMessageServer === "function" &&
		typeof candidate.createChannel === "function" &&
		typeof candidate.createMessage === "function"
	);
}

function resolveShutdownTimeoutMs(envName: string, fallbackMs: number): number {
	const raw = process.env[envName];
	const parsed = Number(raw);
	if (raw?.trim() === "0") return 0;
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return fallbackMs;
}

function timeoutAfter(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		setTimeout(() => resolve("timeout"), ms);
	});
}

interface ResolvedModelRegistration {
	handler: ModelHandler["handler"];
	metadata?: ModelRegistrationMetadata;
	modelKey: string;
	provider: string;
}

export class AgentRuntime implements IAgentRuntime {
	#conversationLength = 100;
	readonly agentId: UUID;
	readonly character: Character;
	public adapter!: IDatabaseAdapter;
	static #anonymousAgentCounter = 0;
	readonly actions: Action[] = [];
	readonly providers: Provider[] = [];
	readonly evaluators: RegisteredEvaluator[] = [];
	readonly responseHandlerEvaluators: ResponseHandlerEvaluator[] = [];
	readonly responseHandlerFieldEvaluators: ResponseHandlerFieldEvaluator[] = [];
	/** Pre-LLM action shortcuts (#8791), registered from `Plugin.shortcuts`. */
	readonly shortcutRegistry = new ShortcutRegistry();
	/** Chat pre-handlers, registered from `Plugin.chatPreHandlers`. */
	readonly chatPreHandlerRegistry = new ChatPreHandlerRegistry();
	readonly responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	readonly turnControllers = new TurnControllerRegistry();
	readonly roomHandlerQueue = new RoomHandlerQueue();
	readonly plugins: Plugin[] = [];
	/**
	 * Per-runtime context registry seeded with first-party context definitions
	 * during `_initializeCore`. Plugins may register additional contexts before
	 * Stage 1 runs.
	 */
	readonly contexts: ContextRegistry = new ContextRegistry([]);
	public unloadPlugin!: (pluginName: string) => Promise<PluginOwnership | null>;
	public reloadPlugin!: (plugin: Plugin) => Promise<void>;
	public applyPluginConfig!: (
		pluginName: string,
		config: Record<string, string>,
	) => Promise<boolean>;
	public getPluginOwnership!: (pluginName: string) => PluginOwnership | null;
	public getAllPluginOwnership!: () => PluginOwnership[];
	events: RuntimeEventStorage = {};
	stateCache = new Map<string, State>();
	readonly fetch = fetch;
	promptBatcher: PromptBatcher;
	services = new Map<ServiceTypeName, Service[]>();
	private serviceTypes = new Map<ServiceTypeName, ServiceClass[]>();

	/**
	 * Bounded ring of failures surfaced via {@link reportError} (#12263). Read
	 * by the RECENT_ERRORS provider and the owner-escalation threshold. Oldest
	 * entries drop once the cap is exceeded.
	 */
	private reportedErrors: ReportedError[] = [];
	private static readonly REPORTED_ERROR_RING_CAP = 200;
	/** Re-entrancy latch so a failure inside reportError stays warn-only (J7). */
	private inReportError = false;
	models = new Map<string, ModelHandler[]>();
	routes: Route[] = [];
	/**
	 * Provider that answered the boot-time TEXT_EMBEDDING dimension probe. The
	 * SQL adapter's vector column is sized from that provider's output, so all
	 * later embedding calls without an explicit provider are pinned to it —
	 * letting a different registration serve an embedding call can emit a
	 * different-width vector that the adapter silently drops on dimension
	 * mismatch (#8769). Re-set on every successful `ensureEmbeddingDimension`.
	 */
	private pinnedEmbeddingProvider: string | undefined;
	/**
	 * The provider name that actually served the most recent successful
	 * `useModel` call for each model type key. Populated the moment a
	 * registration answers (before any streaming/return path), so a caller that
	 * cannot see `useModel`'s internal resolution — e.g. the messageHandler /
	 * factsAndRelationships trajectory stage recorders in `services/message.ts`,
	 * which previously hardcoded the provider as the literal `"default"` — can
	 * read the real provider that answered instead of fabricating one (#13623).
	 * Keyed by the REQUESTED model type string so the recorder for a
	 * RESPONSE_HANDLER / TEXT_LARGE stage reads the provider for that stage's
	 * call, not some other model type's.
	 */
	private lastResolvedModelProviderByType = new Map<string, string>();
	/**
	 * Non-null while embedding generation is disabled because every registered
	 * TEXT_EMBEDDING provider failed the dimension probe. While set, memory
	 * writes skip vector generation entirely (see `addEmbeddingToMemory` /
	 * `queueEmbeddingGeneration`) instead of producing vectors the SQL adapter
	 * would silently drop against a default-sized column. Cleared by the next
	 * successful `ensureEmbeddingDimension` (e.g. the deferred boot re-probe).
	 */
	private embeddingGenerationDisabledReason: string | null = null;
	/** Once-latch so the embedding-skip warning fires once, not per write. */
	private embeddingSkipWarned = false;
	private taskWorkers = new Map<string, TaskWorker>();
	private sendHandlers = new Map<string, SendHandlerFunction>();
	private messageConnectors = new Map<string, MessageConnector>();
	private postConnectors = new Map<string, PostConnector>();
	private searchCategories = new Map<string, SearchCategoryRegistration>();
	private eventHandlers: Map<string, Array<(data: EventPayload) => void>> =
		new Map();

	/**
	 * In-flight execution traces keyed by trace.id (unique uuid).
	 * A single run can produce multiple DPE calls; each gets its own trace.
	 * `runToTraces` maps runId -> set of trace ids for enrichment lookup.
	 */
	private activeTraces = new Map<string, ExecutionTrace>();
	private runToTraces = new Map<string, Set<string>>();
	/** Optional DPE-side prompt optimization I/O (merge, registry, baseline/failure traces). */
	private promptOptimizationHooks: PromptOptimizationRuntimeHooks | null = null;

	private pipelineHookEntries: ResolvedPipelineHook[] = [];
	private pipelineHookIdToIndex = new Map<string, number>();

	// A map of all plugins available to the runtime, keyed by name, for dependency resolution.
	private allAvailablePlugins = new Map<string, Plugin>();
	// The initial list of plugins specified by the character configuration.
	private characterPlugins: Plugin[] = [];
	// Capability options for basic capabilities configuration
	private capabilityOptions: CapabilityConfig = {};
	private readonly nativeFeatureOptions: Partial<
		Record<NativeRuntimeFeature, boolean>
	>;
	// Action planning option (undefined means use settings, true/false is explicit)
	private actionPlanningOption?: boolean;
	// LLM mode option for overriding model selection (undefined means use settings)
	private llmModeOption?: import("./types").LLMModeType;
	// Check should respond option (undefined means use settings, defaults to true)
	private checkShouldRespondOption?: boolean;
	// Flag to track if the character was auto-generated (no character provided)
	private isAnonymousCharacter = false;

	public logger;
	public enableAutonomy: boolean;
	private settings: RuntimeSettings;
	private servicePromiseHandlers = new Map<string, ServicePromiseHandler>(); // Combined handlers for resolve/reject
	private servicePromises = new Map<string, Promise<Service>>(); // read
	/** In-flight service start promises; dedupes concurrent getService() for the same type. */
	private startingServices = new Map<string, Promise<Service | null>>();
	private serviceRegistrationStatus = new Map<
		ServiceTypeName,
		"pending" | "registering" | "registered" | "failed"
	>(); // status tracking
	public initPromise: Promise<void>;
	private initResolver:
		| ((value?: void | PromiseLike<void>) => void)
		| undefined;
	private currentRunId?: UUID; // Track the current run ID
	private currentRoomId?: UUID; // Track the current room for logging
	public messageService: IMessageService | null = null; // Lazily initialized
	public companionUrl?: string;
	/** Set when stop() has been called; prevents new service starts and use-after-stop. */
	private stopped = false;

	constructor(opts: {
		conversationLength?: number;
		agentId?: UUID;
		/** Optional character configuration. If not provided, an anonymous character is created. */
		character?: Character;
		plugins?: Plugin[];
		fetch?: typeof fetch;
		/** Database adapter. Use InMemoryDatabaseAdapter for in-memory-only runs. WHY: Caller owns DB lifecycle; no plugin registration race; single source of truth. */
		adapter?: IDatabaseAdapter;
		settings?: RuntimeSettings;
		allAvailablePlugins?: Plugin[];
		/**
		 * Log level for this runtime. Defaults to "error".
		 * Valid levels: "trace", "debug", "info", "warn", "error", "fatal"
		 */
		logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
		/** Disable basic basic-capabilities capabilities (reply, ignore, none, core providers) */
		disableBasicCapabilities?: boolean;
		/** Enable extended/advanced basic-capabilities capabilities (facts, roles, settings, room actions, etc.) */
		enableExtendedCapabilities?: boolean;
		/** Alias for enableExtendedCapabilities - Enable advanced basic-capabilities capabilities */
		advancedCapabilities?: boolean;
		/**
		 * Enable action planning mode for multi-action execution.
		 * When true (default), agent can plan and execute multiple actions per response.
		 * When false, agent executes only a single action per response (performance optimization
		 * useful for game situations where state updates with every action).
		 */
		actionPlanning?: boolean;
		/**
		 * LLM mode for overriding model selection.
		 * - "DEFAULT": Use the model type specified in the useModel call (no override)
		 * - "SMALL": Override all text generation model calls to use TEXT_SMALL
		 * - "LARGE": Override all text generation model calls to use TEXT_LARGE
		 *
		 * This is useful for cost optimization (force SMALL) or quality (force LARGE).
		 * While not recommended for production, it can be a fast way to make the agent run cheaper.
		 */
		llmMode?: import("./types").LLMModeType;
		/**
		 * Enable or disable the shouldRespond evaluation.
		 * When true (default), the agent evaluates whether to respond to each message.
		 * When false, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
		 */
		checkShouldRespond?: boolean;
		/**
		 * Enable autonomy capabilities for autonomous agent operation.
		 * When true, the agent can operate autonomously with its own thinking loop,
		 * communicating with admin users and running continuous background processing.
		 * Can be enabled at construction time or lazily via settings.
		 */
		enableAutonomy?: boolean;
		/** Enable trust engine, security, and permissions infrastructure. */
		enableTrust?: boolean;
		/** Enable encrypted secrets management and dynamic plugin activation. */
		enableSecretsManager?: boolean;
		/** Enable plugin introspection, install/eject/sync. */
		enablePluginManager?: boolean;
		enableDocuments?: boolean;
		enableRelationships?: boolean;
		enableTrajectories?: boolean;
		/** Optional URL of a long-lived companion runtime for fire-and-forget embedding/task work. WHY: Thin runtimes (e.g. serverless) delegate embeddings and task-dirty notifications without blocking. */
		companionUrl?: string;
	}) {
		// Create default anonymous character if none provided
		let character: Character;
		if (opts.character) {
			character = opts.character;
			this.isAnonymousCharacter = false;
		} else {
			AgentRuntime.#anonymousAgentCounter++;
			character = {
				name: `Agent-${AgentRuntime.#anonymousAgentCounter}`,
				bio: ["An anonymous agent"],
				templates: {},
				messageExamples: [],
				postExamples: [],
				topics: [],
				adjectives: [],
				documents: [],
				plugins: [],
				secrets: {},
			} as Character;
			this.isAnonymousCharacter = true;
		}

		// Resolve the full capability config once, at construction: explicit
		// constructor options win, and any option left unspecified falls back to
		// the matching character setting. initialize() then builds the
		// basic-capabilities plugin from this config, so registerPlugin needs no
		// name-keyed branch to re-derive it. Anonymous characters have no character
		// provider to inject, so skipCharacterProvider is forced on.
		this.capabilityOptions = resolveCapabilityConfig(
			{
				disableBasic: opts.disableBasicCapabilities,
				enableExtended: opts.enableExtendedCapabilities,
				advancedCapabilities: opts.advancedCapabilities,
				skipCharacterProvider: this.isAnonymousCharacter,
				enableAutonomy: opts.enableAutonomy,
				enableTrust: opts.enableTrust,
				enableSecretsManager: opts.enableSecretsManager,
				enablePluginManager: opts.enablePluginManager,
			},
			character.settings as CapabilitySettingFlags | undefined,
		);
		this.nativeFeatureOptions = {
			documents: opts.enableDocuments,
			relationships: opts.enableRelationships,
			trajectories: opts.enableTrajectories,
			// Character flags are the explicit override for these two features
			// (default false in the registry); build-character-config surfaces
			// them as flags deliberately.
			advancedPlanning: character.advancedPlanning,
			advancedMemory: character.advancedMemory,
		};
		// Generate deterministic UUID from character name
		// Falls back to random UUID only if no character name is provided
		this.agentId =
			character.id ?? opts.agentId ?? stringToUuid(character.name ?? uuidv4());
		this.character = character;

		this.initPromise = new Promise((resolve) => {
			this.initResolver = resolve;
		});

		// Create the logger with namespace and log level (defaults to "error")
		this.logger = createLogger({
			namespace: `agent:${character.name ?? "unknown"}`,
			level: opts.logLevel ?? "error",
		});

		// Set conversation length from constructor, settings, or environment
		if (opts.conversationLength !== undefined) {
			this.#conversationLength = opts.conversationLength;
		} else if (opts.settings?.CONVERSATION_LENGTH) {
			this.#conversationLength =
				parseInt(String(opts.settings.CONVERSATION_LENGTH), 10) || 100;
		} else {
			this.#conversationLength =
				getNumberEnv("CONVERSATION_LENGTH", 100) ?? 100;
		}
		if (opts.adapter) {
			this.registerDatabaseAdapter(opts.adapter);
		}
		this.companionUrl = opts.companionUrl;
		this.fetch = (opts.fetch as typeof fetch) ?? this.fetch;
		this.settings = opts.settings ?? environmentSettings;
		const enableAutonomyFromSettings =
			this.character.settings?.ENABLE_AUTONOMY === true ||
			this.character.settings?.ENABLE_AUTONOMY === "true";
		this.enableAutonomy = opts.enableAutonomy ?? enableAutonomyFromSettings;

		this.plugins = []; // Initialize plugins as an empty array
		this.characterPlugins = opts.plugins ?? []; // Store the original character plugins
		this.promptBatcher = new PromptBatcher(
			this,
			new PromptDispatcher({
				packingDensity:
					getNumberEnv("PROMPT_BATCHER_PACKING_DENSITY", 0.85) ?? 0.85,
				maxTokensPerCall:
					getNumberEnv("PROMPT_BATCHER_MAX_TOKENS_PER_CALL", 24_000) ?? 24_000,
				maxParallelCalls:
					getNumberEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", 2) ?? 2,
				modelSeparation:
					getNumberEnv("PROMPT_BATCHER_MODEL_SEPARATION", 1) ?? 1,
				maxSectionsPerCall:
					getNumberEnv("PROMPT_BATCHER_MAX_SECTIONS_PER_CALL", 8) ?? 8,
			}),
			{
				batchSize: getNumberEnv("PROMPT_BATCHER_BATCH_SIZE", 8) ?? 8,
				maxDrainIntervalMs:
					getNumberEnv("PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS", 30_000) ??
					30_000,
				maxSectionsPerCall:
					getNumberEnv("PROMPT_BATCHER_MAX_SECTIONS_PER_CALL", 8) ?? 8,
				packingDensity:
					getNumberEnv("PROMPT_BATCHER_PACKING_DENSITY", 0.85) ?? 0.85,
				maxTokensPerCall:
					getNumberEnv("PROMPT_BATCHER_MAX_TOKENS_PER_CALL", 24_000) ?? 24_000,
				maxParallelCalls:
					getNumberEnv("PROMPT_BATCHER_MAX_PARALLEL_CALLS", 2) ?? 2,
				modelSeparation:
					getNumberEnv("PROMPT_BATCHER_MODEL_SEPARATION", 1) ?? 1,
			},
		);

		// Store action planning option (undefined means check settings at runtime)
		this.actionPlanningOption = opts.actionPlanning;
		// Store LLM mode option (undefined means check settings at runtime)
		this.llmModeOption = opts.llmMode;
		// Store checkShouldRespond option (undefined means check settings at runtime)
		this.checkShouldRespondOption = opts.checkShouldRespond;

		if (opts.allAvailablePlugins) {
			for (const plugin of opts.allAvailablePlugins) {
				if (plugin.name) {
					this.allAvailablePlugins.set(plugin.name, plugin);
				}
			}
		}

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, agentName: this.character.name },
			"Initialized",
		);
		this.currentRunId = undefined; // Initialize run ID tracker

		installRuntimePluginLifecycle(this);
	}

	private warnOnDuplicateServiceTypeRegistration(
		serviceType: ServiceTypeName | string,
		serviceClass: ServiceClass,
		existingServiceClasses: ServiceClass[],
		pluginName?: string,
	): void {
		if (
			existingServiceClasses.length === 0 ||
			serviceClass.allowsMultiple === true ||
			existingServiceClasses.some(
				(existing) => existing.allowsMultiple === true,
			)
		) {
			return;
		}

		this.logger.warn(
			{
				src: "agent",
				agentId: this.agentId,
				plugin: pluginName,
				serviceType,
				serviceClass: getServiceClassLabel(serviceClass),
				existingServiceClasses:
					existingServiceClasses.map(getServiceClassLabel),
			},
			"Duplicate serviceType registration can make getService() ambiguous; use a distinct serviceType or getServicesByType()",
		);
	}

	/**
	 * Create a new run ID for tracking a sequence of model calls
	 */
	createRunId(): UUID {
		return uuidv4() as UUID;
	}

	/**
	 * Start a new run for tracking prompts
	 * @param roomId Optional room ID to associate logs with this conversation
	 */
	startRun(roomId?: UUID): UUID {
		this.currentRunId = this.createRunId();
		this.currentRoomId = roomId;
		return this.currentRunId;
	}

	/**
	 * End the current run
	 */
	endRun(): void {
		this.currentRunId = undefined;
		this.currentRoomId = undefined;
	}

	/**
	 * Get the current run ID (creates one if it doesn't exist)
	 */
	getCurrentRunId(): UUID {
		if (!this.currentRunId) {
			this.currentRunId = this.createRunId();
		}
		return this.currentRunId;
	}

	private resolveServiceTypeAlias(
		serviceType: ServiceTypeName | string,
	): string {
		return serviceType;
	}

	private nativeRuntimeFeatureSettingKey(
		feature: NativeRuntimeFeature,
	): string {
		return `ENABLE_${feature.toUpperCase()}`;
	}

	private resolveNativeFeatureEnabled(feature: NativeRuntimeFeature): boolean {
		const explicit = this.nativeFeatureOptions[feature];
		if (explicit !== undefined) {
			return explicit;
		}

		const settingKey = this.nativeRuntimeFeatureSettingKey(feature);
		const settingValue = parseBooleanValue(this.getSetting(settingKey));
		if (settingValue !== undefined) {
			return settingValue;
		}

		return nativeRuntimeFeatureDefaults[feature];
	}

	private isSecretSwapEnabled(): boolean {
		return (
			parseBooleanValue(this.getSetting(SECRET_SWAP_ENABLED_SETTING)) ?? false
		);
	}

	private createSecretSwapSession(): SecretSwapSession {
		const toSecretStrings = (
			values: Record<string, unknown> | undefined,
		): Record<string, string | undefined> => {
			const result: Record<string, string | undefined> = {};
			const entries = values ? Object.entries(values) : [];
			for (const [key, value] of entries) {
				if (typeof value === "string") {
					result[key] = value;
				}
			}
			return result;
		};
		const settingsSecrets =
			this.character.settings &&
			typeof this.character.settings === "object" &&
			"secrets" in this.character.settings &&
			this.character.settings.secrets &&
			typeof this.character.settings.secrets === "object"
				? toSecretStrings(
						this.character.settings.secrets as Record<string, unknown>,
					)
				: undefined;
		// Registry/config-derived catalog (#10469): seed every secret-bearing env
		// value so a plugin's `FOO_API_KEY` is swapped even when it never appears
		// in a recognised inline token shape. Character secrets win on conflict.
		const envSecrets = deriveKnownSecrets(
			process.env as Record<string, string | undefined>,
		);
		return new SecretSwapSession({
			knownSecrets: {
				...envSecrets,
				...settingsSecrets,
				...toSecretStrings(this.character.secrets),
			},
			exemptValues: parseSecretSwapExemptValues(
				this.getSetting(SECRET_SWAP_EXEMPT_VALUES_SETTING),
			),
		});
	}

	private isPiiSwapEnabled(): boolean {
		return (
			parseBooleanValue(this.getSetting(PII_SWAP_ENABLED_SETTING)) ?? false
		);
	}

	/**
	 * Build the turn's PII pseudonymization session (#10469 / #7007). The
	 * recognizer is the composite of the runtime's built-in regex recognizer
	 * (street addresses) and — if a plugin registered the
	 * `PII_ENTITY_RECOGNIZER_SERVICE` — the local NER model (person/org/location).
	 * With no model plugin present the layer runs regex-only: degraded coverage,
	 * but still never leaks what it does detect. The agent's own name is added to
	 * the blocklist so the model's identity is never pseudonymized.
	 */
	private createPiiSwapSession(): PseudonymSession {
		const recognizers: PiiEntityRecognizer[] = [new RegexEntityRecognizer()];
		const nerService = this.getService(PII_ENTITY_RECOGNIZER_SERVICE) as
			| (Service & Partial<PiiEntityRecognizerService>)
			| null;
		const nerRecognizer = nerService?.getRecognizer?.() ?? null;
		if (nerRecognizer) recognizers.push(nerRecognizer);

		const blocklist = [
			...DEFAULT_PSEUDONYM_BLOCKLIST,
			...(this.character.name ? [this.character.name] : []),
			...parsePiiSwapList(this.getSetting(PII_SWAP_EXEMPT_VALUES_SETTING)),
		];
		return new PseudonymSession({
			recognizer: new CompositeEntityRecognizer(recognizers, { blocklist }),
			blocklist,
			disabledKinds: parsePiiSwapList(
				this.getSetting(PII_SWAP_DISABLED_KINDS_SETTING),
			),
		});
	}

	/** Flatten every string leaf of the model params plus the system prompt into
	 * one text blob for the PII recognizer to scan. */
	private collectPromptText(
		params: unknown,
		systemPrompt: string | undefined,
	): string {
		const parts: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === "string") {
				parts.push(value);
			} else if (Array.isArray(value)) {
				for (const item of value) walk(item);
			} else if (value && typeof value === "object") {
				for (const child of Object.values(value)) walk(child);
			}
		};
		walk(params);
		if (systemPrompt) parts.push(systemPrompt);
		return parts.join("\n");
	}

	private hasNativeRuntimeFeature(feature: NativeRuntimeFeature): boolean {
		const pluginName = nativeRuntimeFeaturePluginNames[feature];
		return this.plugins.some((plugin) => plugin.name === pluginName);
	}

	private resolveNativeFeatureForServiceType(
		serviceType: ServiceTypeName | string,
	): NativeRuntimeFeature | null {
		return resolveNativeRuntimeFeatureFromServiceType(serviceType);
	}

	private isNativeFeatureServiceEnabled(
		serviceType: ServiceTypeName | string,
	): boolean {
		const feature = this.resolveNativeFeatureForServiceType(serviceType);
		if (!feature) {
			return true;
		}
		return this.hasNativeRuntimeFeature(feature);
	}

	private isPluginManagedAsNativeFeature(
		plugin: Plugin | null | undefined,
	): boolean {
		return resolveNativeRuntimeFeatureFromPluginName(plugin?.name) !== null;
	}

	private async setNativeRuntimeFeatureEnabled(
		feature: NativeRuntimeFeature,
		enabled: boolean,
	): Promise<void> {
		const current = this.hasNativeRuntimeFeature(feature);
		if (current === enabled) {
			return;
		}

		if (enabled) {
			await this.registerPlugin(getNativeRuntimeFeaturePlugin(feature));
		} else {
			await this.unloadPlugin(nativeRuntimeFeaturePluginNames[feature]);
		}

		this.setSetting(this.nativeRuntimeFeatureSettingKey(feature), enabled);
	}

	async enableDocuments(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("documents", true);
	}

	async disableDocuments(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("documents", false);
	}

	isDocumentsEnabled(): boolean {
		return this.hasNativeRuntimeFeature("documents");
	}

	async enableRelationships(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("relationships", true);
	}

	async disableRelationships(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("relationships", false);
	}

	isRelationshipsEnabled(): boolean {
		return this.hasNativeRuntimeFeature("relationships");
	}

	async enableTrajectories(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("trajectories", true);
	}

	async disableTrajectories(): Promise<void> {
		await this.setNativeRuntimeFeatureEnabled("trajectories", false);
	}

	isTrajectoriesEnabled(): boolean {
		return this.hasNativeRuntimeFeature("trajectories");
	}

	private hooksForPhase(phase: PipelineHookPhase): ResolvedPipelineHook[] {
		return this.pipelineHookEntries.filter((e) => e.phase === phase);
	}

	private upsertPipelineHook(entry: ResolvedPipelineHook): void {
		const existing = this.pipelineHookIdToIndex.get(entry.id);
		if (existing !== undefined) {
			this.pipelineHookEntries[existing] = entry;
			return;
		}
		this.pipelineHookIdToIndex.set(entry.id, this.pipelineHookEntries.length);
		this.pipelineHookEntries.push(entry);
	}

	private async invokePipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		logLabel: string,
		pipelineHookTelemetry = true,
	): Promise<void> {
		const hooks = sortPipelineHooksByPosition(this.hooksForPhase(phase));
		if (!hooks.length) {
			return;
		}

		const roomId = pipelineHookMetricRoomId(ctx);

		const runOne = async (entry: ResolvedPipelineHook) => {
			const t0 = performance.now();
			let errorMessage: string | undefined;
			try {
				await entry.handler(this, ctx);
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.error(
					{
						src: "agent",
						agentId: this.agentId,
						hookId: entry.id,
						phase: entry.phase,
						error: errorMessage,
					},
					`${logLabel} threw; continuing`,
				);
			}
			{
				const durationMs = Math.round(performance.now() - t0);
				if (!pipelineHookTelemetry) {
					const baseLite = {
						src: "pipeline_hook" as const,
						agentId: this.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_WARN_MS) {
						this.logger.warn(
							baseLite,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.logger.error(
							baseLite,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
				} else {
					const slow = durationMs >= PIPELINE_HOOK_WARN_MS;
					const baseFields = {
						src: "pipeline_hook" as const,
						agentId: this.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_DEBUG_LOG_MS) {
						this.logger.debug(baseFields, "Pipeline hook timing");
					}
					if (slow) {
						this.logger.warn(
							baseFields,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.logger.error(
							baseFields,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					try {
						await this.emitEvent(EventType.PIPELINE_HOOK_METRIC, {
							phase,
							hookId: entry.id,
							durationMs,
							roomId,
							slow,
							...(errorMessage !== undefined ? { error: errorMessage } : {}),
						});
					} catch (metricError) {
						this.logger.debug(
							{
								src: "pipeline_hook",
								agentId: this.agentId,
								hookId: entry.id,
								phase,
								error:
									metricError instanceof Error
										? metricError.message
										: String(metricError),
							},
							"PIPELINE_HOOK_METRIC listener failed",
						);
					}
				}
			}
		};

		if (
			phase === "parallel_with_should_respond" ||
			phase === "model_stream_chunk"
		) {
			await Promise.all(hooks.map((h) => runOne(h)));
			return;
		}

		const mutators = hooks.filter((h) => h.mutatesPrimary);
		const serialReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "serial",
		);
		const concurrentReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "concurrent",
		);

		for (const h of mutators) {
			await runOne(h);
		}
		for (const h of serialReaders) {
			await runOne(h);
		}
		await Promise.all(concurrentReaders.map((h) => runOne(h)));
	}

	registerPipelineHook(spec: PipelineHookSpec): void {
		this.upsertPipelineHook(resolvePipelineHookSpec(spec));
	}

	unregisterPipelineHook(id: string): void {
		const idx = this.pipelineHookIdToIndex.get(id);
		if (idx === undefined) {
			return;
		}
		this.pipelineHookEntries.splice(idx, 1);
		this.pipelineHookIdToIndex.clear();
		for (let i = 0; i < this.pipelineHookEntries.length; i++) {
			const e = this.pipelineHookEntries[i];
			this.pipelineHookIdToIndex.set(e.id, i);
		}
	}

	/**
	 * Run pipeline hooks for a phase (skip metadata, ordering, and outgoing redact).
	 * @param pipelineHookTelemetry When false, skips debug logs / `PIPELINE_HOOK_METRIC` per hook
	 * (still logs warn/error for slow hooks). Defaults to false for `model_stream_chunk` only.
	 */
	async applyPipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		pipelineHookTelemetry?: boolean,
	): Promise<void> {
		if (ctx.phase !== phase) {
			throw new Error(
				`applyPipelineHooks: phase mismatch (expected ${phase}, ctx.phase=${ctx.phase})`,
			);
		}

		const hookTelemetry =
			pipelineHookTelemetry !== undefined
				? pipelineHookTelemetry
				: phase !== "model_stream_chunk";

		const hasHooks = this.hooksForPhase(phase).length > 0;

		switch (phase) {
			case "incoming_before_compose": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "incoming_before_compose" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipIncomingMessageHooks === true) {
					return;
				}
				const messageId = c.message.id;
				await this.invokePipelineHooks(
					phase,
					c,
					"Incoming pipeline hook",
					hookTelemetry,
				);
				if (messageId) {
					this.stateCache.delete(messageId);
					this.stateCache.delete(`${messageId}_action_results`);
				}
				return;
			}
			case "compose_state_providers": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "compose_state_providers" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipComposeStateProviderHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Compose-state provider pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "pre_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "pre_should_respond" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipPreShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Pre-should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "parallel_with_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "parallel_with_should_respond" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipParallelWithShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Parallel should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "outgoing_before_deliver": {
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "outgoing_before_deliver" }
				>;
				if (hasHooks) {
					await this.invokePipelineHooks(
						phase,
						c,
						"Outgoing pipeline hook",
						hookTelemetry,
					);
				}
				c.content.text = this.redactSecrets(
					coerceOutgoingMessageText(c.content.text),
				);
				return;
			}
			case "pre_model":
			case "post_model": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "pre_model" | "post_model" }
					>,
					phase === "pre_model"
						? "Pre-model pipeline hook"
						: "Post-model pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "after_memory_persisted": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "after_memory_persisted" }
				>;
				const md = c.memory.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipAfterMemoryPersistedHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"After-memory-persisted pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "model_stream_chunk":
			case "model_stream_end": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "model_stream_chunk" | "model_stream_end" }
					>,
					phase === "model_stream_chunk"
						? "Model stream chunk pipeline hook"
						: "Model stream end pipeline hook",
					hookTelemetry,
				);
				return;
			}
			default: {
				throw new Error(`Unknown pipeline hook phase: ${String(phase)}`);
			}
		}
	}

	async registerPlugin(plugin: Plugin): Promise<void> {
		if (!plugin.name) {
			// Ensure plugin.name is defined
			const errorMsg = "Plugin or plugin name is undefined";
			this.logger.error(
				{ src: "agent", agentId: this.agentId, error: errorMsg },
				"Plugin registration failed",
			);
			throw new Error(`registerPlugin: ${errorMsg}`);
		}

		// Check if a plugin with the same name is already registered.
		const existingPlugin = this.plugins.find((p) => p.name === plugin.name);
		if (existingPlugin) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, plugin: plugin.name },
				"Plugin already registered, skipping",
			);
			return;
		}

		// Registration is purely structural: whatever plugin the caller declares —
		// including basic-capabilities, already built from the resolved capability
		// config by initialize() — is registered as-is. No name-keyed branch
		// re-derives or rebuilds a specific plugin; capability configuration is
		// owned by the declaring plugin (via resolveCapabilityConfig +
		// createBasicCapabilitiesPlugin), not by this method.
		const pluginToRegister = plugin;
		(this.plugins as Plugin[]).push(pluginToRegister);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
			"Plugin added",
		);

		if (pluginToRegister.init) {
			const config: Record<string, string> = {};
			if (pluginToRegister.config) {
				for (const [key, value] of Object.entries(pluginToRegister.config)) {
					if (value !== null && value !== undefined) {
						config[key] = String(value);
					}
				}
			}
			await pluginToRegister.init(config, this);
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
				"Plugin initialized",
			);
		}
		if (pluginToRegister.adapter) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, plugin: pluginToRegister.name },
				"Plugin declares adapter factory (handled pre-construction)",
			);
		}
		if (pluginToRegister.actions) {
			// Delegate collision/override policy to registerAction() so a single
			// authority (resolveComponentCollision) decides first-wins vs declared
			// override and emits the observable WARN. Pre-filtering here would
			// silently swallow duplicates before that policy could see them.
			for (const action of pluginToRegister.actions) {
				this.registerAction(action);
			}
		}
		if (pluginToRegister.providers) {
			for (const provider of pluginToRegister.providers) {
				if (provider.registerByDefault === false) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							provider: provider.name,
							plugin: pluginToRegister.name,
						},
						"Skipping plugin provider with registerByDefault=false",
					);
					continue;
				}
				// Collision/override policy owned by registerProvider().
				this.registerProvider(provider);
			}
		}
		if (pluginToRegister.evaluators) {
			// Collision/override policy owned by registerEvaluator().
			for (const evaluator of pluginToRegister.evaluators) {
				this.registerEvaluator(evaluator);
			}
		}
		if (pluginToRegister.shortcuts) {
			this.registerShortcuts(pluginToRegister.shortcuts);
		}
		if (pluginToRegister.chatPreHandlers) {
			this.registerChatPreHandlers(pluginToRegister.chatPreHandlers);
		}
		if (pluginToRegister.responseHandlerEvaluators) {
			const existingResponseHandlerEvaluatorNames = new Set(
				this.responseHandlerEvaluators.map((evaluator) => evaluator.name),
			);
			for (const evaluator of pluginToRegister.responseHandlerEvaluators) {
				if (existingResponseHandlerEvaluatorNames.has(evaluator.name)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							evaluator: evaluator.name,
							plugin: pluginToRegister.name,
						},
						"Skipping duplicate plugin response-handler evaluator",
					);
					continue;
				}
				this.registerResponseHandlerEvaluator(evaluator);
				existingResponseHandlerEvaluatorNames.add(evaluator.name);
			}
		}
		if (pluginToRegister.responseHandlerFieldEvaluators) {
			const existingFieldNames = new Set(
				this.responseHandlerFieldEvaluators.map((evaluator) => evaluator.name),
			);
			for (const evaluator of pluginToRegister.responseHandlerFieldEvaluators) {
				if (existingFieldNames.has(evaluator.name)) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							evaluator: evaluator.name,
							plugin: pluginToRegister.name,
						},
						"Skipping duplicate plugin response-handler field evaluator",
					);
					continue;
				}
				this.registerResponseHandlerFieldEvaluator(evaluator);
				existingFieldNames.add(evaluator.name);
			}
		}
		if (pluginToRegister.models) {
			for (const [modelType, handler] of Object.entries(
				pluginToRegister.models,
			)) {
				this.registerModel(
					modelType as ModelTypeName,
					handler as (
						runtime: IAgentRuntime,
						params: Record<string, JsonValue | object>,
					) => Promise<JsonValue | object>,
					pluginToRegister.name,
					pluginToRegister.priority,
					pluginToRegister.modelMetadata?.[modelType],
				);
			}
		}
		if (pluginToRegister.connectorSources) {
			registerConnectorSourceDefinitions(
				pluginToRegister.connectorSources,
				pluginToRegister.name,
			);
		}
		if (pluginToRegister.routes) {
			for (const route of pluginToRegister.routes) {
				assertPublicRouteIntent(route, pluginToRegister.name);
				const routePath = route.path.startsWith("/")
					? route.path
					: `/${route.path}`;
				this.routes.push({
					...route,
					path: route.rawPath
						? routePath
						: `/${pluginToRegister.name}${routePath}`,
				});
			}
		}
		if (pluginToRegister.events) {
			for (const [eventName, eventHandlers] of Object.entries(
				pluginToRegister.events,
			)) {
				for (const eventHandler of eventHandlers) {
					this.registerEvent(
						eventName,
						eventHandler as (params: unknown) => Promise<void>,
					);
				}
			}
		}
		if (pluginToRegister.services) {
			for (const service of pluginToRegister.services) {
				const serviceType = service.serviceType as ServiceTypeName;

				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						plugin: pluginToRegister.name,
						serviceType,
					},
					"Registering service",
				);

				if (!this.servicePromises.has(serviceType)) {
					this._createServiceResolver(serviceType);
				}
				this.serviceRegistrationStatus.set(serviceType, "pending");
				if (!this.serviceTypes.has(serviceType)) {
					this.serviceTypes.set(serviceType, []);
				}
				const services = this.serviceTypes.get(serviceType);
				if (services) {
					this.warnOnDuplicateServiceTypeRegistration(
						serviceType,
						service,
						services,
						pluginToRegister.name,
					);
					services.push(service);
				}

				// Eagerly kick off service start so it is available via the
				// sync getService() by the time actions/routes need it.
				// Fire-and-forget: cannot await here because _runServiceStart
				// awaits initPromise which resolves after initialize() completes
				// (after all registerPlugin calls finish). Awaiting would deadlock.
				this._ensureServiceStarted(serviceType).catch((err) => {
					this.logger.error(
						{
							src: "agent",
							agentId: this.agentId,
							plugin: pluginToRegister.name,
							serviceType,
							error: err instanceof Error ? err.message : String(err),
						},
						"Service start failed",
					);
				});
			}
		}
		if (pluginToRegister.adapter) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					plugin: pluginToRegister.name,
				},
				"Registering database adapter",
			);
			const basicCapabilitiesSettings = this.getBasicCapabilitiesSettings();
			const adapter = await Promise.resolve(
				pluginToRegister.adapter(this.agentId, basicCapabilitiesSettings),
			);
			this.registerDatabaseAdapter(adapter);
		}
	}

	getAllServices(): Map<ServiceTypeName, Service[]> {
		return this.services;
	}

	/**
	 * Stops all started services and clears runtime caches/handlers.
	 * For full teardown (including DB/adapter connection), call close() after stop().
	 */
	async stop(options?: RuntimeStopOptions): Promise<void> {
		if (this.stopped) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Runtime already stopped",
			);
			return;
		}
		const fast = options?.fast === true;
		const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;
		if (fast) {
			process.env.ELIZA_FAST_SHUTDOWN = "1";
		}
		try {
			await this._stopServices(fast);
		} finally {
			if (fast) {
				if (previousFastShutdown === undefined) {
					delete process.env.ELIZA_FAST_SHUTDOWN;
				} else {
					process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
				}
			}
		}
	}

	private async _stopServices(fast: boolean): Promise<void> {
		this.stopped = true;
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, fast },
			"Stopping runtime",
		);

		const inFlightEntries = Array.from(this.startingServices.entries());
		const inFlight = inFlightEntries.map(([, promise]) => promise);
		if (inFlight.length > 0) {
			const serviceTypes = inFlightEntries.map(([serviceType]) => serviceType);
			if (fast) {
				this.logger.info(
					{ src: "agent", agentId: this.agentId, serviceTypes },
					"Fast shutdown: skipping wait for in-flight service starts",
				);
				this.startingServices.clear();
			} else {
				const timeoutMs = resolveShutdownTimeoutMs(
					"ELIZA_SHUTDOWN_SERVICE_START_TIMEOUT_MS",
					DEFAULT_SERVICE_START_SHUTDOWN_TIMEOUT_MS,
				);
				if (timeoutMs === 0) {
					this.logger.info(
						{ src: "agent", agentId: this.agentId, serviceTypes },
						"Skipping wait for in-flight service starts",
					);
					this.startingServices.clear();
				} else {
					this.logger.info(
						{
							src: "agent",
							agentId: this.agentId,
							count: inFlight.length,
							serviceTypes,
							timeoutMs,
						},
						"Waiting for in-flight service starts before stopping",
					);
					const waitStartedAt = Date.now();
					const result = await Promise.race([
						Promise.allSettled(inFlight).then(() => "settled" as const),
						timeoutAfter(timeoutMs),
					]);
					if (result === "timeout" && this.startingServices.size > 0) {
						this.logger.warn(
							{
								src: "agent",
								agentId: this.agentId,
								serviceTypes,
								timeoutMs,
								elapsedMs: Date.now() - waitStartedAt,
							},
							"Timed out waiting for in-flight service starts; proceeding with shutdown",
						);
						this.startingServices.clear();
					}
				}
			}
		}

		const fastStopTasks: Promise<void>[] = [];
		for (const [serviceType, services] of this.services) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, serviceType },
				"Stopping service",
			);
			for (const service of services) {
				if (fast) {
					fastStopTasks.push(
						this._stopServiceInstance(serviceType, service, "fast shutdown"),
					);
				} else {
					await this._stopServiceInstance(serviceType, service, "shutdown");
				}
			}
		}
		if (fast && fastStopTasks.length > 0) {
			const timeoutMs = resolveShutdownTimeoutMs(
				"ELIZA_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS",
				DEFAULT_FAST_SERVICE_STOP_TIMEOUT_MS,
			);
			if (timeoutMs > 0) {
				await Promise.race([
					Promise.allSettled(fastStopTasks),
					timeoutAfter(timeoutMs),
				]);
			} else {
				await Promise.allSettled(fastStopTasks);
			}
		}

		// Reject any pending service load promises so callers don't hang
		const stopError = new Error("Runtime stopped");
		for (const [serviceType, handler] of this.servicePromiseHandlers) {
			handler.reject(stopError);
			const promise = this.servicePromises.get(serviceType);
			if (promise) {
				// error-policy:J5 unhandled-rejection suppression — the rejection is
				// delivered to getServiceLoadPromise() awaiters via handler.reject
				// above; this only silences unhandled-rejection noise at shutdown.
				void promise.catch(() => {});
			}
		}

		// Clear caches and handlers to avoid use-after-stop and release references
		this.promptBatcher.dispose();
		this.eventHandlers.clear();
		this.events = {};
		this.stateCache.clear();
		this.servicePromises.clear();
		this.servicePromiseHandlers.clear();
		this.startingServices.clear();
	}

	private async _stopServiceInstance(
		serviceType: string,
		service: Service | null | undefined,
		reason: string,
	): Promise<void> {
		const maybe = service as { stop?: () => Promise<void> | void } | null;
		if (maybe && typeof maybe.stop === "function") {
			try {
				await Promise.resolve().then(() => maybe.stop?.());
			} catch (err) {
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						serviceType,
						reason,
						error: err instanceof Error ? err.message : String(err),
					},
					"Service stop() threw; continuing",
				);
			}
		} else if (!maybe) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, serviceType, reason },
				"Null service instance during stop; skipping",
			);
		} else {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, serviceType, reason },
				"Service instance is missing stop(); skipping",
			);
		}
	}

	/**
	 * Slim init: register plugins, ensure adapter ready, create message service.
	 * Does NOT run migrations, agent/entity/room creation, or embedding dimension.
	 * WHY: Those belong to provisioning (once at daemon boot); edge/ephemeral skip them.
	 */
	async initialize(options?: {
		skipMigrations?: boolean;
		/** Allow running without a persistent database adapter (benchmarks/tests). */
		allowNoDatabase?: boolean;
	}): Promise<void> {
		try {
			await this._initializeCore(options);
		} catch (err) {
			// Always resolve initPromise so eager service starts and stop()
			// do not hang waiting on a promise that never settles.
			if (this.initResolver) {
				this.initResolver();
				this.initResolver = undefined;
			}
			throw err;
		}
	}

	private async _initializeCore(options?: {
		skipMigrations?: boolean;
		allowNoDatabase?: boolean;
	}): Promise<void> {
		// Seed the per-runtime context registry with the first-party taxonomy
		// before any plugin registers. Subsequent plugin/extension calls to
		// `runtime.contexts.tryRegister(...)` will be idempotent on these ids.
		const { skipped: skippedContexts } = this.contexts.tryRegisterMany(
			DEFAULT_CONTEXT_DEFINITIONS,
		);
		for (const id of skippedContexts) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, context: id },
				"First-party context already registered, skipping",
			);
		}

		// Register the canonical core response-handler field evaluators. These
		// own the top-level properties of the Stage-1 LLM's structured output
		// (shouldRespond, contexts, intents, candidateActionNames, replyText,
		// facts, relationships, addressedTo). Plugins may register additional
		// fields (e.g. app-lifeops contributes `threadOps`).
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			this.registerResponseHandlerFieldEvaluator(evaluator);
		}

		const pluginRegistrationPromises: Promise<void>[] = [];

		// Basic capabilities are now built into core - auto-register it first
		const basicCapabilitiesPlugin = createBasicCapabilitiesPlugin(
			this.capabilityOptions,
		);
		pluginRegistrationPromises.push(
			this.registerPlugin(basicCapabilitiesPlugin),
		);

		// Always-on core message-path security defenses. Registered through the
		// plugin lifecycle (GHSA-gh63-5vpj-39qp incoming-message hardening + #9949
		// injection-risk stamping) so their pipeline hooks appear in plugin
		// bookkeeping and dispose with the runtime, rather than a lazy dynamic
		// import buried in initialize.
		pluginRegistrationPromises.push(
			this.registerPlugin(createCoreSecurityHooksPlugin()),
		);

		for (const feature of Object.keys(
			nativeRuntimeFeatureDefaults,
		) as NativeRuntimeFeature[]) {
			const enabled = this.resolveNativeFeatureEnabled(feature);
			if (enabled) {
				pluginRegistrationPromises.push(
					this.registerPlugin(getNativeRuntimeFeaturePlugin(feature)),
				);
			}
		}

		for (const plugin of this.characterPlugins) {
			if (plugin && !this.isPluginManagedAsNativeFeature(plugin)) {
				pluginRegistrationPromises.push(this.registerPlugin(plugin));
			}
		}
		await Promise.all(pluginRegistrationPromises);
		for (const warning of getActionRolePolicyWarnings(this.actions)) {
			if (warning.type === "unmatched") {
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						action: warning.actionName,
						policyRole: warning.policyRole,
					},
					"[AgentRuntime] ACTION_ROLE_POLICY entry does not match a registered action name",
				);
				continue;
			}
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					action: warning.actionName,
					policyRole: warning.policyRole,
					declaredRole: warning.declaredRole,
				},
				"[AgentRuntime] ACTION_ROLE_POLICY entry lowers the action's declared role gate",
			);
		}

		const allowNoDatabase =
			options?.allowNoDatabase === true ||
			String(this.getSetting("ALLOW_NO_DATABASE") ?? "").toLowerCase() ===
				"true" ||
			String(process.env.ALLOW_NO_DATABASE ?? "").toLowerCase() === "true";

		if (!this.adapter) {
			if (allowNoDatabase) {
				this.logger.warn(
					{ src: "agent", agentId: this.agentId },
					"Database adapter not initialized; using in-memory adapter (ALLOW_NO_DATABASE)",
				);
				this.registerDatabaseAdapter(new InMemoryDatabaseAdapter());
			} else {
				this.logger.error(
					{ src: "agent", agentId: this.agentId },
					"Database adapter not initialized",
				);
				throw new Error(
					"Database adapter not initialized. The SQL plugin (@elizaos/plugin-sql) is required for agent initialization. Please ensure it is included in your character configuration.",
				);
			}
		}

		// Make adapter init idempotent - check if already initialized
		if (!(await this.adapter.isReady())) {
			await this.adapter.initialize();
		}

		// Initialize message service
		this.messageService = new DefaultMessageService();

		// Run migrations for all loaded plugins (unless explicitly skipped for serverless mode)
		const skipMigrations = options?.skipMigrations ?? false;
		if (skipMigrations) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Skipping plugin migrations",
			);
		} else {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Running plugin migrations",
			);
			await this.runPluginMigrations();
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Plugin migrations completed",
			);
		}

		// Ensure character has the agent ID set before calling ensureAgentExists
		// We create a new object with the ID to avoid mutating the original character
		const existingAgent = await this.ensureAgentExists({
			...this.character,
			id: this.agentId,
		} as Partial<Agent>);
		if (!existingAgent) {
			const errorMsg = `Agent ${this.agentId} does not exist in database after ensureAgentExists call`;
			throw new Error(errorMsg);
		}

		// Merge DB-persisted settings back into runtime character
		// This ensures settings from previous runs are available
		if (existingAgent.settings) {
			const dbSettings = isPlainObject(existingAgent.settings)
				? existingAgent.settings
				: {};
			const dbExtraSettings = isPlainObject(dbSettings.extra)
				? dbSettings.extra
				: {};
			const dbSettingsSecrets = isPlainObject(dbSettings.secrets)
				? dbSettings.secrets
				: {};
			const characterSettings = isPlainObject(this.character.settings)
				? this.character.settings
				: {};
			const characterExtraSettings = isPlainObject(characterSettings.extra)
				? characterSettings.extra
				: {};
			const characterSettingsSecrets = isPlainObject(characterSettings.secrets)
				? characterSettings.secrets
				: {};
			const characterSecrets =
				this.character.secrets && typeof this.character.secrets === "object"
					? this.character.secrets
					: {};
			const dbSettingsWithRuntimeOverrides = { ...existingAgent.settings };

			for (const key of Object.keys(this.settings)) {
				const runtimeValue = this.getRuntimeSettingValue(key);
				if (runtimeValue === undefined) {
					continue;
				}

				const hasDbValue =
					Object.hasOwn(dbSettings, key) ||
					Object.hasOwn(dbExtraSettings, key) ||
					Object.hasOwn(dbSettingsSecrets, key);
				const hasCharacterValue =
					Object.hasOwn(characterSettings, key) ||
					Object.hasOwn(characterExtraSettings, key) ||
					Object.hasOwn(characterSettingsSecrets, key) ||
					Object.hasOwn(characterSecrets, key);

				if (hasDbValue && !hasCharacterValue) {
					dbSettingsWithRuntimeOverrides[key] = runtimeValue;
				}
			}

			this.character.settings = {
				...dbSettingsWithRuntimeOverrides,
				...this.character.settings, // Character file overrides DB
			};

			// Merge secrets from both character.secrets and settings.secrets
			// getSetting() checks character.secrets first, so we need to merge there too
			const dbSecrets =
				existingAgent.secrets && typeof existingAgent.secrets === "object"
					? existingAgent.secrets
					: {};
			const runtimeSecretOverrides: Record<string, string | boolean | number> =
				{};

			for (const key of Object.keys(this.settings)) {
				const runtimeValue = this.getRuntimeSettingValue(key);
				if (runtimeValue === undefined) {
					continue;
				}

				const hasDbSecret =
					Object.hasOwn(dbSecrets, key) ||
					Object.hasOwn(dbSettingsSecrets, key);
				const hasCharacterSecret =
					Object.hasOwn(characterSecrets, key) ||
					Object.hasOwn(characterSettingsSecrets, key);

				if (hasDbSecret && !hasCharacterSecret) {
					runtimeSecretOverrides[key] = runtimeValue;
				}
			}

			// Merge into both locations that getSetting() checks
			const mergedSecrets = {
				...dbSecrets,
				...dbSettingsSecrets,
				...runtimeSecretOverrides,
				...characterSecrets,
				...characterSettingsSecrets, // character settings.secrets has priority
			};

			if (Object.keys(mergedSecrets).length > 0) {
				const filteredSecrets: Record<string, string> = {};
				for (const [key, value] of Object.entries(mergedSecrets)) {
					if (value !== null && value !== undefined) {
						filteredSecrets[key] = String(value);
					}
				}
				if (Object.keys(filteredSecrets).length > 0) {
					this.character.secrets = filteredSecrets;
					this.character.settings.secrets = filteredSecrets;
				}
			}
		}

		// No need to transform agent's own ID
		let agentEntity =
			(await this.adapter.getEntitiesByIds([this.agentId]))[0] ?? null;

		if (!agentEntity) {
			if (!existingAgent.id) {
				throw new Error(`Agent ${this.agentId} has no ID`);
			}
			const created = await this.createEntity({
				id: this.agentId,
				names: [this.character.name ?? "Agent"],
				metadata: {},
				agentId: existingAgent.id,
			});
			if (!created) {
				const errorMsg = `Failed to create entity for agent ${this.agentId}`;
				throw new Error(errorMsg);
			}

			agentEntity =
				(await this.adapter.getEntitiesByIds([this.agentId]))[0] ?? null;
			if (!agentEntity)
				throw new Error(`Agent entity not found for ${this.agentId}`);

			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Agent entity created",
			);
		}

		// Room creation and participant setup
		const room = await this.getRoom(this.agentId);
		if (!room) {
			await this.adapter.createRooms([
				{
					id: this.agentId,
					name: this.character.name,
					source: "elizaos",
					type: ChannelType.SELF,
					channelId: this.agentId,
					messageServerId: this.agentId,
					worldId: this.agentId,
				},
			]);
		}
		const [participantsResult] = await this.adapter.getParticipantsForRooms([
			this.agentId,
		]);
		const participantIds = participantsResult.entityIds;
		if (!participantIds.includes(this.agentId)) {
			const added = await this.adapter.createRoomParticipants(
				[this.agentId],
				this.agentId,
			);
			if (!added.length) {
				throw new Error(
					`Failed to add agent ${this.agentId} as participant to its own room`,
				);
			}
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Agent linked to room",
			);
		}

		const embeddingModel = this.getModel(ModelType.TEXT_EMBEDDING);
		if (!embeddingModel) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"No TEXT_EMBEDDING model registered, skipping embedding setup",
			);
		} else {
			try {
				await this.ensureEmbeddingDimension();
			} catch (error) {
				if (!(error instanceof EmbeddingDimensionProbeError)) {
					throw error;
				}
				// Every registered TEXT_EMBEDDING provider failed the dimension
				// probe. Do not abort boot: ensureEmbeddingDimension() has already
				// flipped the runtime into embedding-disabled mode, so memory writes
				// skip vector generation instead of emitting vectors the SQL adapter
				// would silently drop against its default-sized column (#8769). The
				// deferred boot re-probe (packages/agent) re-runs the probe after
				// late plugins register and re-enables embeddings on success.
				this.logger.error(
					{
						src: "agent",
						agentId: this.agentId,
						attempts: error.attempts,
					},
					"All registered TEXT_EMBEDDING providers failed the dimension probe; continuing boot with embedding generation disabled — memory recall over new memories is degraded until a provider recovers",
				);
			}
		}

		// Resolve init promise to allow services to start
		if (this.initResolver) {
			this.initResolver();
			this.initResolver = undefined;
		}
	}

	private getBasicCapabilitiesSettings(): Record<string, string> {
		const out: Record<string, string> = {};

		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && value !== null && key) {
				out[key] = String(value);
			}
		}

		const settings =
			this.character.settings && typeof this.character.settings === "object"
				? this.character.settings
				: {};
		for (const [key, value] of Object.entries(settings)) {
			if (value === undefined || value === null) {
				continue;
			}
			if (key === "secrets" && typeof value === "object") {
				continue;
			}
			out[key] = typeof value === "string" ? value : String(value);
		}

		const secrets =
			this.character.settings?.secrets &&
			typeof this.character.settings.secrets === "object"
				? this.character.settings.secrets
				: {};
		for (const [key, value] of Object.entries(secrets)) {
			if (value !== undefined && value !== null) {
				out[key] = String(value);
			}
		}

		const topSecrets =
			this.character.secrets && typeof this.character.secrets === "object"
				? this.character.secrets
				: {};
		for (const [key, value] of Object.entries(topSecrets)) {
			if (value !== undefined && value !== null) {
				out[key] = String(value);
			}
		}

		return out;
	}

	registerDatabaseAdapter(adapter: IDatabaseAdapter) {
		if (this.adapter) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter already registered, ignoring",
			);
		} else {
			this.adapter = adapter;
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"Database adapter registered",
			);
		}
	}

	async runPluginMigrations(): Promise<void> {
		if (!this.adapter) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter not found, skipping plugin migrations",
			);
			return;
		}

		if (typeof this.adapter.runPluginMigrations !== "function") {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter does not support plugin migrations",
			);
			return;
		}

		const pluginsWithSchemas = this.plugins
			.filter((p) => p.schema)
			.map((p) => {
				const schema = p.schema || {};
				const normalizedSchema: Record<string, JsonValue> = {};
				for (const [key, value] of Object.entries(schema)) {
					if (
						typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean" ||
						value === null ||
						(typeof value === "object" && value !== null)
					) {
						normalizedSchema[key] = value as JsonValue;
					}
				}
				return { name: p.name, schema: normalizedSchema };
			});

		if (pluginsWithSchemas.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"No plugins with schemas, skipping migrations",
			);
			return;
		}

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, count: pluginsWithSchemas.length },
			"Found plugins with schemas",
		);

		const isProduction = process.env.NODE_ENV === "production";
		const forceDestructive =
			process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

		await this.adapter.runPluginMigrations(pluginsWithSchemas, {
			verbose: !isProduction,
			force: forceDestructive,
			dryRun: false,
		});

		this.logger.debug(
			{ src: "agent", agentId: this.agentId },
			"Plugin migrations completed",
		);
	}

	async getConnection(): Promise<object> {
		// Updated return type
		if (!this.adapter) {
			throw new Error("Database adapter not registered");
		}
		return this.adapter.getConnection();
	}

	setSetting(key: string, value: string | boolean | null, secret = false) {
		if (secret) {
			if (!this.character.secrets) {
				this.character.secrets = {};
			}
			if (value !== null && value !== undefined) {
				// Secrets are stored as strings
				this.character.secrets[key] = String(value);
			}
		} else {
			if (!this.character.settings) {
				this.character.settings = {};
			}
			if (value !== null && value !== undefined) {
				this.character.settings[key] = value;
			}
		}
	}

	private getCharacterEnvSetting(
		key: string,
	): string | boolean | number | undefined {
		const env = (this.character as { env?: unknown }).env;
		if (!env || typeof env !== "object" || Array.isArray(env)) {
			return undefined;
		}

		const envRecord = env as Record<string, unknown>;
		const vars =
			envRecord.vars &&
			typeof envRecord.vars === "object" &&
			!Array.isArray(envRecord.vars)
				? (envRecord.vars as Record<string, unknown>)
				: undefined;

		const directValue = envRecord[key];
		if (
			typeof directValue === "string" ||
			typeof directValue === "boolean" ||
			typeof directValue === "number"
		) {
			return directValue;
		}

		const varsValue = vars?.[key];
		if (
			typeof varsValue === "string" ||
			typeof varsValue === "boolean" ||
			typeof varsValue === "number"
		) {
			return varsValue;
		}
		return undefined;
	}

	private getRuntimeSettingValue(
		key: string,
	): string | boolean | number | undefined {
		const value = this.settings[key];
		if (
			typeof value === "string" ||
			typeof value === "boolean" ||
			typeof value === "number"
		) {
			return value;
		}
		return undefined;
	}

	getSetting(key: string): string | boolean | number | null {
		const settings = this.character.settings;
		const secrets = this.character.secrets;
		const extraSettings =
			settings &&
			typeof settings === "object" &&
			"extra" in settings &&
			typeof settings.extra === "object" &&
			settings.extra !== null
				? (settings.extra as Record<
						string,
						string | boolean | number | undefined
					>)
				: undefined;
		const nestedSecrets =
			typeof settings === "object" &&
			settings !== null &&
			"secrets" in settings &&
			typeof settings.secrets === "object" &&
			settings.secrets !== null
				? (settings.secrets as Record<string, string | undefined>)
				: undefined;

		const value =
			secrets?.[key] ??
			settings?.[key] ??
			extraSettings?.[key] ??
			nestedSecrets?.[key] ??
			this.getCharacterEnvSetting(key) ??
			this.getRuntimeSettingValue(key);

		// Handle each type appropriately
		if (value === undefined || value === null) {
			return null;
		}

		if (typeof value === "number") {
			return value;
		}

		if (typeof value === "boolean") {
			return value;
		}

		if (typeof value === "string") {
			// Only decrypt string values
			const decrypted = decryptSecret(value, getSalt());
			if (decrypted === "true") return true;
			if (decrypted === "false") return false;
			return decrypted;
		}

		return null;
	}

	getConversationLength() {
		return this.#conversationLength;
	}

	/**
	 * Check if action planning mode is enabled.
	 *
	 * When enabled (default), the agent can plan and execute multiple actions per response.
	 * When disabled, the agent executes only a single action per response - a performance
	 * optimization useful for game situations where state updates with every action.
	 *
	 * Priority: constructor option > character setting ACTION_PLANNING > default (true)
	 */
	isActionPlanningEnabled(): boolean {
		// Constructor option takes precedence
		if (this.actionPlanningOption !== undefined) {
			return this.actionPlanningOption;
		}

		// Check character settings
		const setting = this.getSetting("ACTION_PLANNING");
		if (setting !== null) {
			if (typeof setting === "boolean") {
				return setting;
			}
			if (typeof setting === "string") {
				return setting.toLowerCase() === "true";
			}
		}

		// Default to true (action planning enabled)
		return true;
	}

	/**
	 * Get the LLM mode for model selection override.
	 *
	 * - `DEFAULT`: Use the model type specified in the useModel call (no override)
	 * - `SMALL`: Override all text generation model calls to use TEXT_SMALL
	 * - `LARGE`: Override all text generation model calls to use TEXT_LARGE
	 *
	 * Priority: constructor option > character setting LLM_MODE > default (DEFAULT)
	 */
	getLLMMode(): import("./types").LLMModeType {
		// Constructor option takes precedence
		if (this.llmModeOption !== undefined) {
			return this.llmModeOption;
		}

		// Check character settings
		const setting = this.getSetting("LLM_MODE");
		if (setting !== null && typeof setting === "string") {
			const upper = setting.toUpperCase();
			if (upper === "SMALL" || upper === "LARGE" || upper === "DEFAULT") {
				return upper as import("./types").LLMModeType;
			}
		}

		// Default to DEFAULT (no override)
		return "DEFAULT";
	}

	/**
	 * Check if the shouldRespond evaluation is enabled.
	 *
	 * When enabled (default: true), the agent evaluates whether to respond to each message.
	 * When disabled, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.
	 *
	 * Priority: constructor option > character setting CHECK_SHOULD_RESPOND > default (true)
	 */
	isCheckShouldRespondEnabled(): boolean {
		// Constructor option takes precedence
		if (this.checkShouldRespondOption !== undefined) {
			return this.checkShouldRespondOption;
		}

		// Check character settings
		const setting = this.getSetting("CHECK_SHOULD_RESPOND");
		if (setting !== null) {
			if (typeof setting === "boolean") {
				return setting;
			}
			if (typeof setting === "string") {
				return setting.toLowerCase() !== "false";
			}
		}

		// Default to true (check should respond is enabled)
		return true;
	}

	getOptimizationDir(): string {
		const setting = this.getSetting("OPTIMIZATION_DIR");
		return getOptimizationRootDir(typeof setting === "string" ? setting : null);
	}

	registerPromptOptimizationHooks(
		hooks: PromptOptimizationRuntimeHooks | null,
	): void {
		this.promptOptimizationHooks = hooks;
	}

	getPromptOptimizationHooks(): PromptOptimizationRuntimeHooks | null {
		return this.promptOptimizationHooks;
	}

	resolveProviderModelString(
		resolvedModelType: string,
		optionsModel?: string,
		effectiveModelId?: string,
	): string {
		if (effectiveModelId) return effectiveModelId;
		if (optionsModel) return optionsModel;

		const slotToSetting: Record<string, string> = {
			TEXT_NANO: "NANO_MODEL",
			TEXT_MINI: "MINI_MODEL",
			TEXT_SMALL: "SMALL_MODEL",
			TEXT_LARGE: "LARGE_MODEL",
			TEXT_MEGA: "MEGA_MODEL",
			RESPONSE_HANDLER: "RESPONSE_HANDLER_MODEL",
			ACTION_PLANNER: "ACTION_PLANNER_MODEL",
			REASONING_SMALL: "REASONING_SMALL_MODEL",
			REASONING_LARGE: "REASONING_LARGE_MODEL",
			TEXT_COMPLETION: "COMPLETION_MODEL",
		};

		const providerPrefixes = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""];
		for (const candidate of getModelFallbackChain(
			resolvedModelType as ModelTypeName,
		)) {
			const settingKey = slotToSetting[candidate];
			if (!settingKey) continue;
			for (const prefix of providerPrefixes) {
				const val = this.getSetting(`${prefix}${settingKey}`);
				if (typeof val === "string" && val) return val;
			}
		}

		return resolvedModelType;
	}

	enrichTrace(runId: string, signal: ScoreSignal): void {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return;

		const targetTraceId = (signal as { traceId?: string }).traceId;

		for (const tid of traceIds) {
			if (targetTraceId && tid !== targetTraceId) continue;

			const trace = this.activeTraces.get(tid);
			if (!trace) continue;
			trace.scoreCard.signals.push(signal);
			const card = ScoreCard.fromJSON(trace.scoreCard);
			trace.scoreCard.compositeScore = card.composite();
			trace.enrichedAt = Date.now();
		}
	}

	getActiveTrace(runId: string): ExecutionTrace | undefined {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return undefined;
		let latest: ExecutionTrace | undefined;
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) latest = t;
		}
		return latest;
	}

	getActiveTracesForRun(runId: string): ExecutionTrace[] {
		const traceIds = this.runToTraces.get(runId);
		if (!traceIds) return [];
		const traces: ExecutionTrace[] = [];
		for (const tid of traceIds) {
			const t = this.activeTraces.get(tid);
			if (t) traces.push(t);
		}
		return traces;
	}

	deleteActiveTrace(runId: string): void {
		const traceIds = this.runToTraces.get(runId);
		if (traceIds) {
			for (const tid of traceIds) {
				this.activeTraces.delete(tid);
			}
			this.runToTraces.delete(runId);
		}
	}

	deleteActiveTraceById(traceId: string): void {
		this.activeTraces.delete(traceId);
		for (const [rid, tids] of this.runToTraces) {
			if (tids.delete(traceId) && tids.size === 0) {
				this.runToTraces.delete(rid);
			}
		}
	}

	private static readonly ACTIVE_TRACE_TTL_MS = 5 * 60 * 1000;
	private activeTraceTtlPurgeCounter = 0;

	private purgeStaleActiveTraces(): void {
		const now = Date.now();
		const ttl = AgentRuntime.ACTIVE_TRACE_TTL_MS;
		for (const [id, t] of this.activeTraces) {
			if (now - t.createdAt <= ttl) continue;
			this.activeTraces.delete(id);
			for (const [rid, tids] of this.runToTraces) {
				tids.delete(id);
				if (tids.size === 0) this.runToTraces.delete(rid);
			}
		}
	}

	private maybeRunActiveTraceTTLPurge(): void {
		if (++this.activeTraceTtlPurgeCounter % 100 !== 0) return;
		this.purgeStaleActiveTraces();
	}

	/**
	 * Get the messaging adapter if available
	 *
	 * WHY: Messaging functionality is optional (only SQL adapters support it).
	 * Client plugins check this before using messaging features.
	 *
	 * @returns IMessagingAdapter if the current adapter implements it, null otherwise
	 */
	getMessagingAdapter(): IMessagingAdapter | null {
		// Check if the adapter implements IMessagingAdapter interface
		// by checking for presence of messaging-specific methods
		if (this.adapter && isMessagingAdapter(this.adapter)) {
			return this.adapter;
		}
		return null;
	}

	/**
	 * Shared collision policy for the three primary component registries
	 * (actions, providers, evaluators). Registration is deterministic first-wins:
	 * the earliest-registered component of a given name is authoritative and the
	 * order in which plugins register is stable across a boot.
	 *
	 * A later registrant of the same name is either:
	 *  - a DECLARED override (`override: true`) — an intentional supersede. We log
	 *    the takeover at INFO and instruct the caller to replace the incumbent.
	 *  - an UNDECLARED collision — two plugins claimed the same name without one
	 *    declaring precedence. This is the unsafe, order-sensitive case the
	 *    arch-audit flagged: which component wins used to be decided by a silent
	 *    first-wins dedupe. We now keep the incumbent (still deterministic) but
	 *    surface a WARN so the drift is observable instead of silent.
	 *
	 * @returns `true` if the caller should REPLACE the incumbent (declared
	 *   override), `false` if it should keep the incumbent and skip the newcomer.
	 */
	private resolveComponentCollision(
		kind: "action" | "provider" | "evaluator",
		name: string,
		override: boolean | undefined,
	): boolean {
		if (override === true) {
			this.logger.info(
				{ src: "agent", agentId: this.agentId, [kind]: name },
				`[AgentRuntime] ${kind} "${name}" declares override:true — superseding the already-registered ${kind} of the same name.`,
			);
			return true;
		}
		this.logger.warn(
			{ src: "agent", agentId: this.agentId, [kind]: name },
			`[AgentRuntime] ${kind} name collision: a ${kind} named "${name}" is already registered; keeping the first and skipping this one. Which one wins is load-order-dependent — give the two distinct names, or set override:true on the ${kind} that should intentionally supersede.`,
		);
		return false;
	}

	registerProvider(provider: Provider) {
		const canonical = withCanonicalProviderDocs(provider);
		const existingIndex = this.providers.findIndex(
			(p) => p.name === canonical.name,
		);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision(
					"provider",
					canonical.name,
					canonical.override,
				)
			) {
				this.providers[existingIndex] = canonical;
			}
			return;
		}
		this.providers.push(canonical);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, provider: canonical.name },
			"Provider registered",
		);
	}

	registerAction(action: Action) {
		const canonical = withCanonicalActionDocs(action);
		Object.assign(action, canonical);
		const existingIndex = this.actions.findIndex((a) => a.name === action.name);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision("action", action.name, action.override)
			) {
				this.actions[existingIndex] = action;
			}
		} else {
			this.actions.push(action);
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, action: action.name },
				"Action registered",
			);
		}
	}

	/** Register a pre-LLM action shortcut (#8791) into this runtime's registry. */
	registerShortcut(shortcut: ShortcutDefinition) {
		this.shortcutRegistry.register(shortcut);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, shortcut: shortcut.id },
			"Shortcut registered",
		);
	}

	registerShortcuts(shortcuts: readonly ShortcutDefinition[]) {
		for (const shortcut of shortcuts) this.registerShortcut(shortcut);
	}

	unregisterShortcut(id: string) {
		this.shortcutRegistry.unregister(id);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, shortcut: id },
			"Shortcut unregistered",
		);
	}

	/** Register a chat pre-handler into this runtime's registry. */
	registerChatPreHandler(handler: ChatPreHandler) {
		this.chatPreHandlerRegistry.register(handler);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, preHandler: handler.id },
			"Chat pre-handler registered",
		);
	}

	registerChatPreHandlers(handlers: readonly ChatPreHandler[]) {
		for (const handler of handlers) this.registerChatPreHandler(handler);
	}

	unregisterChatPreHandler(id: string) {
		this.chatPreHandlerRegistry.unregister(id);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, preHandler: id },
			"Chat pre-handler unregistered",
		);
	}

	/**
	 * Drain registered chat pre-handlers by priority before normal action
	 * processing; the first non-null result short-circuits the turn.
	 */
	drainChatPreHandlers(
		ctx: ChatPreHandlerContext,
	): Promise<ChatPreHandlerResult | null> {
		return this.chatPreHandlerRegistry.drain(ctx);
	}

	registerEvaluator(evaluator: RegisteredEvaluator) {
		const existingIndex = this.evaluators.findIndex(
			(item) => item.name === evaluator.name,
		);
		if (existingIndex !== -1) {
			if (
				this.resolveComponentCollision(
					"evaluator",
					evaluator.name,
					evaluator.override,
				)
			) {
				this.evaluators[existingIndex] = evaluator;
			}
			return;
		}
		this.evaluators.push(evaluator);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: evaluator.name },
			"Evaluator registered",
		);
	}

	unregisterEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.evaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.evaluators.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Evaluator unregistered",
		);
		return true;
	}

	registerResponseHandlerEvaluator(evaluator: ResponseHandlerEvaluator) {
		if (
			this.responseHandlerEvaluators.find(
				(item) => item.name === evaluator.name,
			)
		) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					evaluator: evaluator.name,
				},
				"Response-handler evaluator already registered, skipping",
			);
			return;
		}
		this.responseHandlerEvaluators.push(evaluator);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				evaluator: evaluator.name,
			},
			"Response-handler evaluator registered",
		);
	}

	unregisterResponseHandlerEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.responseHandlerEvaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.responseHandlerEvaluators.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Response-handler evaluator unregistered",
		);
		return true;
	}

	registerResponseHandlerFieldEvaluator(
		evaluator: ResponseHandlerFieldEvaluator,
	) {
		if (
			this.responseHandlerFieldEvaluators.find(
				(item) => item.name === evaluator.name,
			)
		) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					evaluator: evaluator.name,
				},
				"Response-handler field evaluator already registered, skipping",
			);
			return;
		}
		this.responseHandlerFieldEvaluators.push(evaluator);
		this.responseHandlerFieldRegistry.register(evaluator);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				evaluator: evaluator.name,
				priority: evaluator.priority ?? 100,
			},
			"Response-handler field evaluator registered",
		);
	}

	unregisterResponseHandlerFieldEvaluator(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.responseHandlerFieldEvaluators.findIndex(
			(evaluator) => evaluator.name === normalized,
		);
		if (index === -1) return false;
		this.responseHandlerFieldEvaluators.splice(index, 1);
		this.responseHandlerFieldRegistry.unregister(normalized);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, evaluator: normalized },
			"Response-handler field evaluator unregistered",
		);
		return true;
	}

	/**
	 * Abort the active turn for `roomId`. Convenience wrapper for
	 * `turnControllers.abortTurn`. Returns true if a turn was aborted.
	 */
	abortTurn(roomId: string, reason: string): boolean {
		return this.turnControllers.abortTurn(roomId, reason);
	}

	unregisterAction(name: string): boolean {
		const normalized = typeof name === "string" ? name.trim() : "";
		if (!normalized) return false;
		const index = this.actions.findIndex(
			(action) => action.name === normalized,
		);
		if (index === -1) return false;
		this.actions.splice(index, 1);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, action: normalized },
			"Action unregistered",
		);
		return true;
	}

	getAllActions(): Action[] {
		return [...this.actions];
	}

	/**
	 * Get actions filtered by tool policy.
	 *
	 * @param context - Optional policy context for filtering
	 * @returns Filtered actions based on policy
	 */
	async getFilteredActions(context?: {
		profile?: ToolProfileId;
		characterPolicy?: ToolPolicyConfig;
		channelPolicy?: ToolPolicyConfig;
		providerPolicy?: ToolPolicyConfig;
		worldPolicy?: ToolPolicyConfig;
		roomPolicy?: ToolPolicyConfig;
	}): Promise<Action[]> {
		const policyService = (await this._ensureServiceStarted(
			"tool_policy",
		)) as ToolPolicyService | null;

		if (!policyService || !context) {
			return [...this.actions];
		}

		return policyService.filterActions(this.actions, context);
	}

	/**
	 * Check if a specific action is allowed by tool policy.
	 *
	 * @param actionName - The action name to check
	 * @param context - Optional policy context
	 * @returns Whether the action is allowed
	 */
	async isActionAllowed(
		actionName: string,
		context?: {
			profile?: ToolProfileId;
			characterPolicy?: ToolPolicyConfig;
			channelPolicy?: ToolPolicyConfig;
			providerPolicy?: ToolPolicyConfig;
			worldPolicy?: ToolPolicyConfig;
			roomPolicy?: ToolPolicyConfig;
		},
	): Promise<{ allowed: boolean; reason: string }> {
		const policyService = (await this._ensureServiceStarted(
			"tool_policy",
		)) as ToolPolicyService | null;

		if (!policyService) {
			return { allowed: true, reason: "No policy service available" };
		}

		const result = policyService.isToolAllowed(actionName, context);
		return { allowed: result.allowed, reason: result.reason };
	}

	getActionResults(messageId: UUID): ActionResult[] {
		const cachedState = this.stateCache.get(`${messageId}_action_results`);
		return (
			(cachedState?.data &&
				(cachedState.data.actionResults as ActionResult[])) ||
			[]
		);
	}

	/**
	 * Run actions whose `mode` matches the given hook position. The runtime
	 * fires this from fixed places in the message pipeline (see
	 * services/message.ts). DURING modes execute handlers in parallel; all
	 * other hook modes run sequentially in `modePriority` ascending order.
	 * CONTEXT hooks are gated by `selectedContexts` overlapping the action's
	 * `contexts`.
	 */
	async runActionsByMode(
		mode: ActionMode,
		message: Memory,
		state?: State,
		options?: {
			didRespond?: boolean;
			callback?: HandlerCallback;
			responses?: Memory[];
			selectedContexts?: readonly AgentContext[];
		},
	): Promise<Action[]> {
		let candidates = this.actions.filter((action) => action.mode === mode);

		if (
			mode === "CONTEXT_BEFORE" ||
			mode === "CONTEXT_DURING" ||
			mode === "CONTEXT_AFTER"
		) {
			const selected = new Set(options?.selectedContexts ?? []);
			candidates = candidates.filter((action) => {
				const tags = action.contexts ?? [];
				return tags.some((tag) => selected.has(tag));
			});
		}

		candidates = candidates
			.slice()
			.sort(
				(a, b) =>
					(a.modePriority ?? 100) - (b.modePriority ?? 100) ||
					a.name.localeCompare(b.name),
			);
		if (candidates.length === 0) return [];

		setTrajectoryPurpose(mode === "ALWAYS_AFTER" ? "evaluation" : "hook");

		const validated: Action[] = [];
		await Promise.all(
			candidates.map(async (action) => {
				try {
					const ok = await action.validate(this, message, state);
					if (ok) validated.push(action);
				} catch (err) {
					this.logger.warn(
						{
							src: "agent",
							agentId: this.agentId,
							action: action.name,
							mode,
							err: err instanceof Error ? err.message : String(err),
						},
						"runActionsByMode validate failed",
					);
				}
			}),
		);
		if (validated.length === 0) return [];

		validated.sort(
			(a, b) =>
				(a.modePriority ?? 100) - (b.modePriority ?? 100) ||
				a.name.localeCompare(b.name),
		);

		const composedState =
			state ?? (await this.composeState(message, ["RECENT_MESSAGES"]));

		const messageId = message.id;
		const roomId = message.roomId;
		const worldId = message.worldId ?? roomId;

		const runOne = async (action: Action) => {
			const callback = options?.callback;
			const actionCallback: HandlerCallback | undefined = callback
				? (response, actionName) =>
						callback(response, actionName ?? action.name)
				: undefined;
			await this.emitEvent(EventType.ACTION_STARTED, {
				runtime: this,
				messageId,
				roomId,
				world: worldId,
				content: {
					text: `Executing ${mode} action: ${action.name}`,
					actions: [action.name],
					actionStatus: "executing",
					source: message.content.source,
				},
			}).catch((err) =>
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// event bus must not abort the action, but it must surface.
				this.reportError("AgentRuntime.emitEvent", err, {
					event: EventType.ACTION_STARTED,
					messageId,
				}),
			);

			let success = true;
			let errorMsg: string | undefined;
			try {
				await runWithActionRoutingContext(
					{ actionName: action.name, modelClass: action.modelClass },
					() =>
						action.handler(
							this,
							message,
							composedState,
							{ mode },
							actionCallback,
							options?.responses,
						),
				);
			} catch (err) {
				success = false;
				errorMsg = err instanceof Error ? err.message : String(err);
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						action: action.name,
						mode,
						err: errorMsg,
					},
					"runActionsByMode handler failed",
				);
			}

			await this.emitEvent(EventType.ACTION_COMPLETED, {
				runtime: this,
				messageId,
				roomId,
				world: worldId,
				content: {
					text: success
						? `${mode} action ${action.name} completed`
						: `${mode} action ${action.name} failed: ${errorMsg ?? "unknown"}`,
					actions: [action.name],
					actionStatus: success ? "completed" : "failed",
					source: message.content.source,
					error: errorMsg,
				},
			}).catch((err) =>
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// event bus must not abort the action, but it must surface.
				this.reportError("AgentRuntime.emitEvent", err, {
					event: EventType.ACTION_COMPLETED,
					messageId,
				}),
			);
		};

		const isDuring =
			mode === "ALWAYS_DURING" ||
			mode === "CONTEXT_DURING" ||
			mode === "RESPONSE_HANDLER_DURING";
		if (isDuring) {
			await Promise.all(validated.map(runOne));
		} else {
			for (const action of validated) {
				await runOne(action);
			}
		}

		return validated;
	}

	// highly SQL optimized queries
	async ensureConnections(
		entities: Entity[],
		rooms: Room[],
		source: string,
		world: World,
	): Promise<void> {
		// guards
		if (!entities) {
			this.logger.error(
				{ src: "agent", agentId: this.agentId },
				"ensureConnections called without entities",
			);
			return;
		}
		if (!rooms || rooms.length === 0) {
			this.logger.error(
				{ src: "agent", agentId: this.agentId },
				"ensureConnections called without rooms",
			);
			return;
		}

		// Create/ensure the world exists for this server
		await this.ensureWorldExists({ ...world, agentId: this.agentId });

		const firstRoom = rooms[0];

		// Helper function for chunking arrays
		const chunkArray = <T>(arr: T[], size: number): T[][] =>
			arr.reduce((chunks: T[][], item: T, i: number) => {
				if (i % size === 0) chunks.push([]);
				chunks[chunks.length - 1].push(item);
				return chunks;
			}, []);

		// Step 1: Create all rooms FIRST (before adding any participants)
		const roomIds = rooms.map((r: { id: UUID }) => r.id);
		const roomExistsCheck = await this.getRoomsByIds(roomIds);
		const roomsIdExists = roomExistsCheck.map((r: { id: UUID }) => r.id);
		const roomsToCreate = roomIds.filter(
			(id: UUID) => !roomsIdExists.includes(id),
		);

		const rf = {
			worldId: world.id,
			messageServerId: world.messageServerId,
			source,
			agentId: this.agentId,
		};

		if (roomsToCreate.length) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, count: roomsToCreate.length },
				"Creating rooms",
			);
			const roomObjsToCreate: Room[] = rooms
				.filter((r) => roomsToCreate.includes(r.id))
				.map((r) => ({ ...r, ...rf, type: r.type || ChannelType.GROUP }));
			await this.createRooms(roomObjsToCreate);
		}

		// Step 2: Create all entities
		const entityIds = entities
			.map((e) => e.id)
			.filter((id): id is UUID => id !== undefined);
		const entityExistsCheck = await this.adapter.getEntitiesByIds(entityIds);
		const entitiesToUpdate =
			entityExistsCheck
				.map((e) => e.id)
				.filter((id): id is UUID => id !== undefined) || [];
		const entitiesToCreate = entities.filter(
			(e) => e.id !== undefined && !entitiesToUpdate.includes(e.id),
		);

		const r = {
			roomId: firstRoom.id,
			channelId: firstRoom.channelId,
			type: firstRoom.type,
		};
		const wf = {
			worldId: world.id,
			messageServerId: world.messageServerId,
		};

		if (entitiesToCreate.length) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, count: entitiesToCreate.length },
				"Creating entities",
			);
			const ef = {
				...r,
				...wf,
				source,
				agentId: this.agentId,
			};
			const entitiesToCreateWFields: Entity[] = entitiesToCreate.map((e) => ({
				...e,
				...ef,
				metadata: e.metadata || {},
			}));
			// pglite doesn't like over 10k records
			const batches = chunkArray(entitiesToCreateWFields, 5000);
			for (const batch of batches) {
				await this.createEntities(batch);
			}
		}

		// Step 3: Now add all participants (rooms and entities must exist by now)
		// Always add the agent to the first room
		await this.ensureParticipantInRoom(this.agentId, firstRoom.id);

		// Add all entities to the first room
		const entityIdsInFirstRoom = await this.getParticipantsForRoom(
			firstRoom.id,
		);
		const entityIdsInFirstRoomFiltered = entityIdsInFirstRoom.filter(
			(id): id is UUID => id !== undefined,
		);
		const missingIdsInRoom = entityIds.filter(
			(id: UUID) => !entityIdsInFirstRoomFiltered.includes(id),
		);

		if (missingIdsInRoom.length) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					count: missingIdsInRoom.length,
					channelId: firstRoom.id,
				},
				"Adding missing participants",
			);
			// pglite handle this at over 10k records fine though
			const batches = chunkArray(missingIdsInRoom, 5000);
			for (const batch of batches) {
				await this.createRoomParticipants(batch, firstRoom.id);
			}
		}

		this.logger.success(
			{ src: "agent", agentId: this.agentId, worldId: world.id },
			"World connected",
		);
	}

	async ensureConnection(params: {
		entityId: UUID;
		roomId: UUID;
		roomName?: string;
		worldId?: UUID;
		worldName?: string;
		userName?: string;
		name?: string;
		source?: string;
		type?: ChannelType | string;
		channelId?: string;
		messageServerId?: UUID;
		userId?: UUID;
		metadata?: Record<string, JsonValue>;
	}) {
		const result = await ensureConnectionStandalone(this.adapter, {
			agentId: this.agentId,
			worldId: params.worldId,
			messageServerId: params.messageServerId,
			...params,
			source: params.source ?? "default",
		});
		if (result.createdRoomParticipants > 0) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					entityId: params.entityId,
					channelId: params.roomId,
					createdRoomParticipants: result.createdRoomParticipants,
				},
				"Entity connected",
			);
		}
	}

	async ensureParticipantInRoom(entityId: UUID, roomId: UUID) {
		// Make sure entity exists in database before adding as participant
		const entity = (await this.adapter.getEntitiesByIds([entityId]))[0] ?? null;

		// If entity is not found but it's not the agent itself, we might still want to proceed
		// This can happen when an entity exists in the database but isn't associated with this agent
		if (!entity && entityId !== this.agentId) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, entityId },
				"Entity not accessible, attempting to add as participant",
			);
		} else if (!entity && entityId === this.agentId) {
			throw new Error(
				`Agent entity ${entityId} not found, cannot add as participant.`,
			);
		} else if (!entity) {
			throw new Error(
				`User entity ${entityId} not found, cannot add as participant.`,
			);
		}
		const participantsResult = await this.adapter.getParticipantsForRooms([
			roomId,
		]);
		const participants = participantsResult[0]?.entityIds ?? [];
		if (!participants.includes(entityId)) {
			// Add participant using the ID
			const added = await this.adapter.createRoomParticipants(
				[entityId],
				roomId,
			);

			if (!added) {
				throw new Error(
					`Failed to add participant ${entityId} to room ${roomId}`,
				);
			}
			if (entityId === this.agentId) {
				this.logger.debug(
					{ src: "agent", agentId: this.agentId, channelId: roomId },
					"Agent linked to room",
				);
			} else {
				this.logger.debug(
					{ src: "agent", agentId: this.agentId, entityId, channelId: roomId },
					"User linked to room",
				);
			}
		}
	}

	async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
		return this.adapter.getParticipantsForEntities([entityId]);
	}

	async getParticipantsForEntities(entityIds: UUID[]): Promise<Participant[]> {
		return this.adapter.getParticipantsForEntities(entityIds);
	}

	async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
		const result = await this.adapter.getParticipantsForRooms([roomId]);
		return result[0]?.entityIds ?? [];
	}

	async getParticipantsForRooms(
		roomIds: UUID[],
	): Promise<import("./types/database").ParticipantsForRoomsResult> {
		return this.adapter.getParticipantsForRooms(roomIds);
	}

	async isRoomParticipant(roomId: UUID, entityId: UUID): Promise<boolean> {
		const results = await this.adapter.areRoomParticipants([
			{ roomId, entityId },
		]);
		return results[0] ?? false;
	}

	async areRoomParticipants(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<boolean[]> {
		return this.adapter.areRoomParticipants(pairs);
	}

	async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		const ids = await this.adapter.createRoomParticipants([entityId], roomId);
		return ids.length > 0;
	}

	async createRoomParticipants(
		entityIds: UUID[],
		roomId: UUID,
	): Promise<UUID[]> {
		return this.adapter.createRoomParticipants(entityIds, roomId);
	}

	/**
	 * Ensure the existence of a world.
	 *
	 * WHY upsert: Eliminates race condition where concurrent agent basic-capabilitiess
	 * could both try to create the same world. Upsert is atomic.
	 */
	async ensureWorldExists({ id, name, messageServerId, metadata }: World) {
		// Check if world exists (for logging only)
		const world = (await this.adapter.getWorldsByIds([id]))[0] ?? null;

		// Atomic upsert - handles both insert and update
		await this.adapter.upsertWorlds([
			{
				id,
				name,
				agentId: this.agentId,
				messageServerId,
				metadata,
			},
		]);

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, worldId: id, messageServerId },
			world ? "World updated" : "World created",
		);
	}

	/**
	 * Ensure the existence of a room.
	 *
	 * WHY upsert: Eliminates race condition where concurrent connection attempts
	 * (e.g., Discord bot receiving messages in same channel simultaneously) could
	 * both try to create the same room. Upsert is atomic.
	 */
	async ensureRoomExists({
		id,
		name,
		source,
		type,
		channelId,
		messageServerId,
		worldId,
		metadata,
	}: Room) {
		if (!worldId) throw new Error("worldId is required");

		// Check if room exists (for logging only)
		const room = await this.getRoom(id);

		// Atomic upsert - handles both insert and update
		await this.adapter.upsertRooms([
			{
				id,
				name,
				agentId: this.agentId,
				source,
				type,
				channelId,
				messageServerId,
				worldId,
				metadata,
			},
		]);

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, channelId: id },
			room ? "Room updated" : "Room created",
		);
	}

	async composeState(
		message: Memory,
		includeList: string[] | null = null,
		onlyInclude = false,
		skipCache = false,
		refreshProviders: string[] | null = null,
	): Promise<State> {
		const trajectoryStepIdFromMessage =
			typeof message.metadata === "object" &&
			message.metadata !== null &&
			"trajectoryStepId" in message.metadata
				? (message.metadata as { trajectoryStepId?: string }).trajectoryStepId
				: undefined;
		const trajectoryStepId =
			typeof trajectoryStepIdFromMessage === "string" &&
			trajectoryStepIdFromMessage.trim() !== ""
				? trajectoryStepIdFromMessage
				: getTrajectoryContext()?.trajectoryStepId;

		// When composing state for a recorded trajectory step, every requested
		// provider re-executes (see providersToRun below) so provider accesses
		// are logged. Recording must not change what providers OBSERVE: the
		// turn's cached state still flows to them — and into the merged result —
		// exactly as it would without the recorder. Blanking it here made
		// providers that read prior-pass state (e.g. RECENT_MESSAGES' turn-
		// recompose gate on cross-room interactions) behave differently whenever
		// trajectories were active.
		const filterList = onlyInclude ? includeList : null;
		const emptyObj = {
			values: {},
			data: {},
			text: "",
		} as State;
		const cachedState =
			skipCache || !message.id
				? emptyObj
				: this.stateCache.get(message.id) || emptyObj;
		const activeContexts = getActiveRoutingContextsForTurn(
			cachedState,
			message,
		);
		const providerNames = new Set<string>();
		if (filterList && filterList.length > 0) {
			// The onlyInclude path honors the explicit name list without enforcing
			// provider roleGates: the Stage-1 response state deliberately
			// force-includes recall providers like FACTS for every sender, and
			// unassigned senders (ordinary humans AND relay/webhook bridges
			// carrying human conversation) resolve to GUEST by default (roles.ts
			// getEntityRole), so gate enforcement here would silently strip
			// cross-turn recall from exactly the turns that need it. Callers that
			// name a provider explicitly own that inclusion decision.
			for (const name of filterList) {
				providerNames.add(name);
			}
		} else {
			for (const p of this.providers.filter((p) => !p.private && !p.dynamic)) {
				if (
					activeContexts.length > 0 &&
					!shouldIncludeByContext(resolveProviderContexts(p), activeContexts)
				) {
					continue;
				}
				providerNames.add(p.name);
			}
		}
		if (!filterList && includeList && includeList.length > 0) {
			for (const name of includeList) {
				providerNames.add(name);
			}
		}
		// Opt-in provider-selection hook: lets a host app filter, extend, or
		// reorder the provider set per message intent before any provider runs.
		// Guarded so the default (no-hook) path stays allocation-free.
		if (this.hooksForPhase("compose_state_providers").length > 0) {
			const selection = composeStateProvidersPipelineHookContext({
				message,
				providers: { current: [...providerNames] },
				activeContexts,
				onlyInclude,
				includeList,
			});
			await this.applyPipelineHooks("compose_state_providers", selection);
			// Boundary validation: a buggy hook may replace `current` with a
			// non-array (or throw mid-mutation). Only adopt a well-formed list;
			// otherwise keep the pre-hook selection rather than crash the turn.
			const selected = selection.providers.current;
			if (Array.isArray(selected)) {
				providerNames.clear();
				for (const name of selected) {
					if (typeof name === "string" && name.length > 0) {
						providerNames.add(name);
					}
				}
			} else {
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						phase: "compose_state_providers",
					},
					"compose_state_providers hook left providers.current non-array; keeping pre-hook selection",
				);
			}
		}
		const providersToGet: Provider[] = [];
		for (const provider of this.providers) {
			if (providerNames.has(provider.name)) {
				providersToGet.push(provider);
			}
		}
		providersToGet.sort(
			(a, b) =>
				(a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name),
		);

		// `refreshProviders` lets a caller REUSE cached provider results for the
		// requested set and re-run only the named providers (plus any not yet in
		// the cache) — e.g. the planner pass refreshes only RECENT_MESSAGES (which
		// changes after an early reply) and reuses everything the first compose
		// already ran for this message.id. The full requested set still drives the
		// rendered text/order below (pulled from `currentProviderResults`, which
		// merges cache + fresh); only the run-set shrinks. No-op (run everything)
		// when `refreshProviders` is null or there is no cached state. Also a
		// no-op while a trajectory step is recording: reusing a cached result
		// would leave that provider's access out of the step's log, so every
		// requested provider re-executes (against the same cached state a
		// non-recording compose would hand it).
		const refreshSet =
			refreshProviders && refreshProviders.length > 0 && !trajectoryStepId
				? new Set(refreshProviders)
				: null;
		const cachedProviderNames = refreshSet
			? new Set(
					Object.keys(
						(cachedState.data.providers as
							| Record<string, unknown>
							| undefined) ?? {},
					),
				)
			: null;
		const providersToRun = refreshSet
			? providersToGet.filter(
					(p) => refreshSet.has(p.name) || !cachedProviderNames?.has(p.name),
				)
			: providersToGet;

		// Optional trajectory logging service; absent unless configured.
		const trajLogger = (await this._ensureServiceStarted("trajectories")) as
			| (Service & TrajectoryProviderAccessLogger)
			| null;
		const composeStartedAt = Date.now();
		const providerData = await Promise.all(
			providersToRun.map(async (provider) => {
				const start = Date.now();
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				let timedOut = false;
				const providerRuntime: IAgentRuntime = this;
				try {
					const result = await Promise.race([
						withProviderStep(providerRuntime, provider.name, () =>
							provider.get(providerRuntime, message, cachedState),
						),
						new Promise<ProviderResult>((resolve) => {
							timeoutHandle = setTimeout(() => {
								timedOut = true;
								this.logger.error(
									{
										src: "agent",
										agentId: this.agentId,
										provider: provider.name,
										timeoutMs: COMPOSE_STATE_PROVIDER_TIMEOUT_MS,
									},
									"Provider timed out during state composition",
								);
								resolve({ text: "", values: {}, data: {} });
							}, COMPOSE_STATE_PROVIDER_TIMEOUT_MS);
						}),
					]);
					const duration = Date.now() - start;

					if (!timedOut) {
						recordInferenceSpan(`provider:${provider.name}`, duration);
					}

					// Only log slow successful providers. Timed-out providers already logged above.
					if (!timedOut && duration > 100) {
						this.logger.debug(
							{
								src: "agent",
								agentId: this.agentId,
								provider: provider.name,
								duration,
							},
							"Slow provider",
						);
					}
					return {
						...result,
						providerName: provider.name,
					};
				} catch (error) {
					this.logger.error(
						{
							src: "agent",
							agentId: this.agentId,
							provider: provider.name,
							error: error instanceof Error ? error.message : String(error),
						},
						"Provider failed during state composition",
					);
					return {
						text: "",
						values: {},
						data: {},
						providerName: provider.name,
					};
				} finally {
					if (timeoutHandle !== undefined) {
						clearTimeout(timeoutHandle);
					}
				}
			}),
		);
		recordInferenceSpan("composeState", Date.now() - composeStartedAt, {
			providers: providersToRun.length,
			reused: providersToGet.length - providersToRun.length,
		});

		const currentProviderResults: Record<
			string,
			{
				text?: string;
				values?: Record<string, ProviderValue>;
				providerName: string;
			}
		> = {
			...(cachedState.data.providers as
				| Record<
						string,
						{
							text?: string;
							values?: Record<string, ProviderValue>;
							providerName: string;
						}
				  >
				| undefined),
		};
		for (const freshResult of providerData) {
			// Redact secrets from individual provider text results
			const redactedText = freshResult.text
				? this.redactSecrets(freshResult.text)
				: freshResult.text;
			currentProviderResults[freshResult.providerName] = {
				...freshResult,
				text: redactedText,
				values:
					freshResult.values && typeof freshResult.values === "object"
						? Object.fromEntries(
								Object.entries(freshResult.values).filter(
									([, value]) => value !== undefined,
								),
							)
						: undefined,
			};
		}
		const orderedTexts: string[] = [];
		for (const provider of providersToGet) {
			const result = currentProviderResults[provider.name];
			if (
				result?.text &&
				typeof result.text === "string" &&
				result.text.trim() !== ""
			) {
				orderedTexts.push(result.text);
			}
		}
		// Redact any secrets from provider context before use
		const rawProvidersText = orderedTexts.join("\n");
		const providersText = this.redactSecrets(rawProvidersText);
		const providerOrderNames = providersToGet.map((provider) => provider.name);
		const attributionState = {
			values: {},
			data: {
				providerOrder: providerOrderNames,
				providers: currentProviderResults,
			},
			text: providersText,
		} as State;
		const providerAttribution = buildProviderAttributionsFromState({
			state: attributionState,
			prompt: providersText,
		});
		const providerAttributionByName = new Map(
			providerAttribution.providerAttributions.map((entry) => [
				entry.providerName,
				entry,
			]),
		);
		const activeTrajectoryContext = getTrajectoryContext();
		if (activeTrajectoryContext) {
			activeTrajectoryContext.providerOrder = providerAttribution.providerOrder;
			activeTrajectoryContext.providerAttributions =
				providerAttribution.providerAttributions;
		}
		if (trajectoryStepId && trajLogger) {
			const userText =
				typeof message.content.text === "string" ? message.content.text : "";
			const trajCtx = activeTrajectoryContext;
			const providerTraceId = this.getActiveTrace(this.getCurrentRunId())?.id;
			for (const r of providerData) {
				try {
					const redactedText =
						currentProviderResults[r.providerName]?.text ?? "";
					const attribution = providerAttributionByName.get(r.providerName);
					trajLogger.logProviderAccess({
						stepId: trajectoryStepId,
						providerName: r.providerName,
						data: { textLength: redactedText.length },
						sha256: attribution?.sha256,
						tokenCount: attribution?.tokenCount,
						position: attribution?.position,
						spanStart: attribution?.spanStart,
						spanEnd: attribution?.spanEnd,
						purpose: "compose_state",
						query: { message: userText.slice(0, 2000) },
						runId: trajCtx?.runId,
						roomId: trajCtx?.roomId,
						messageId: trajCtx?.messageId,
						executionTraceId: providerTraceId,
					});
				} catch {
					// Trajectory logging must never break core message flow.
				}
			}
		}
		const conversationSeed = buildDeterministicSeed(
			this.agentId,
			message.roomId,
			"conversation",
		);
		const aggregatedStateValues: Record<string, StateValue> = {
			...cachedState.values,
		};
		for (const provider of providersToGet) {
			const providerResult = currentProviderResults[provider.name];
			if (
				providerResult?.values &&
				typeof providerResult.values === "object" &&
				providerResult.values !== null
			) {
				Object.assign(aggregatedStateValues, providerResult.values);
			}
		}
		const providersToGetNames = new Set(providersToGet.map((p) => p.name));
		for (const providerName in currentProviderResults) {
			if (!providersToGetNames.has(providerName)) {
				const providerResult = currentProviderResults[providerName];
				if (
					providerResult?.values &&
					typeof providerResult.values === "object" &&
					providerResult.values !== null
				) {
					Object.assign(aggregatedStateValues, providerResult.values);
				}
			}
		}
		const newState = {
			values: {
				...aggregatedStateValues,
				__conversationSeed: conversationSeed,
				providers: providersText,
			},
			data: {
				...cachedState.data,
				__conversationSeed: conversationSeed,
				providerOrder: providerOrderNames,
				providers: currentProviderResults,
			},
			text: providersText,
		} as State;
		if (message.id) {
			this.stateCache.set(message.id, newState);
			// Evict oldest entries beyond the cap. The just-set entry and recent
			// in-flight turns are kept; only stale messages drop out.
			while (this.stateCache.size > STATE_CACHE_LIMIT) {
				const oldest = this.stateCache.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				this.stateCache.delete(oldest);
			}
		}
		return newState;
	}

	/** Lazy service start: used internally by _ensureServiceStarted / getServiceLoadPromise. */
	/** Dedupes concurrent starts for the same type via startingServices so only one start runs. */
	private async _ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null> {
		if (this.stopped) return null;
		if (!this.isNativeFeatureServiceEnabled(serviceType)) return null;
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		const instances = this.services.get(key);
		if (instances && instances.length > 0) {
			return instances[0];
		}
		const classes = this.serviceTypes.get(key);
		if (!classes || classes.length === 0) {
			return null;
		}
		let inFlight = this.startingServices.get(key);
		if (!inFlight) {
			// Start ALL registered service classes for this type, not just the first.
			// This supports multiple services of the same type (e.g. multiple wallet services).
			inFlight = (async () => {
				let first: Service | null = null;
				for (const cls of classes) {
					const result = await this._runServiceStart(key, serviceType, cls);
					if (result && !first) first = result;
				}
				return first;
			})();
			this.startingServices.set(key, inFlight);
		}
		try {
			return await inFlight;
		} finally {
			this.startingServices.delete(key);
		}
	}

	/** Runs one service start; used by _ensureServiceStarted with startingServices dedupe. */
	private async _runServiceStart(
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: ServiceClass,
	): Promise<Service | null> {
		this.serviceRegistrationStatus.set(key, "registering");
		await this.initPromise;
		if (typeof serviceDef.start !== "function") {
			this.logger.error(
				{ src: "agent", agentId: this.agentId, serviceType },
				"Service class has no static start method",
			);
			this.serviceRegistrationStatus.set(key, "failed");
			return null;
		}
		try {
			if (this.stopped) {
				this.serviceRegistrationStatus.set(key, "failed");
				return null;
			}
			const serviceInstance = await serviceDef.start(this);
			if (!serviceInstance) {
				this.serviceRegistrationStatus.set(key, "failed");
				return null;
			}
			if (this.stopped) {
				await this._stopServiceInstance(
					key,
					serviceInstance,
					"late service start after runtime stop",
				);
				this.serviceRegistrationStatus.set(key, "failed");
				return null;
			}
			if (!this.services.has(key)) {
				this.services.set(key, []);
			}
			const serviceList = this.services.get(key);
			if (serviceList) {
				serviceList.push(serviceInstance);
			}
			const handler = this.servicePromiseHandlers.get(serviceType);
			if (handler) {
				handler.resolve(serviceInstance);
				this.servicePromiseHandlers.delete(serviceType);
			}
			if (serviceDef.registerSendHandlers) {
				serviceDef.registerSendHandlers(this, serviceInstance);
			}
			this.serviceRegistrationStatus.set(key, "registered");
			return serviceInstance;
		} catch (error) {
			this.logger.error(
				{
					src: "agent",
					agentId: this.agentId,
					serviceType,
					error: error instanceof Error ? error.message : String(error),
				},
				"Service start failed",
			);
			const handler = this.servicePromiseHandlers.get(serviceType);
			if (handler) {
				handler.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
				this.servicePromiseHandlers.delete(serviceType);
				this.servicePromises.delete(serviceType);
			}
			this.serviceRegistrationStatus.set(key, "failed");
			return null;
		}
	}

	/** Returns the service instance or null. Synchronous lookup from the services map. */
	getService<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T | null {
		if (!this.isNativeFeatureServiceEnabled(serviceName)) {
			return null;
		}
		const key = this.resolveServiceTypeAlias(serviceName) as ServiceTypeName;
		const instances = this.services.get(key);
		if (instances && instances.length > 0) {
			return instances[0] as T;
		}
		return null;
	}

	/**
	 * Type-safe service getter that ensures the correct service type is returned
	 * @template T - The expected service class type
	 * @param serviceName - The service type name
	 * @returns The service instance with proper typing, or null if not found
	 */
	getTypedService<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T | null {
		return this.getService<T>(serviceName);
	}

	/**
	 * Get all services of a specific type
	 * @template T - The expected service class type
	 * @param serviceName - The service type name
	 * @returns Array of service instances with proper typing
	 */
	getServicesByType<T extends Service = Service>(
		serviceName: ServiceTypeName | string,
	): T[] {
		if (!this.isNativeFeatureServiceEnabled(serviceName)) {
			return [];
		}
		const key = this.resolveServiceTypeAlias(serviceName) as ServiceTypeName;
		const serviceInstances = this.services.get(key);
		if (!serviceInstances || serviceInstances.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId, serviceName: key },
				"No services found for type",
			);
			return [];
		}
		return serviceInstances as T[];
	}

	/**
	 * Get all registered service types, including lazy-registered services
	 * that have not started.
	 * @returns Array of registered service type names
	 */
	getRegisteredServiceTypes(): ServiceTypeName[] {
		return Array.from(this.serviceTypes.keys());
	}

	/**
	 * Check if a service type is registered; its class may still be awaiting
	 * startup.
	 * @param serviceType - The service type to check
	 * @returns true if the service is registered
	 */
	hasService(serviceType: ServiceTypeName | string): boolean {
		if (!this.isNativeFeatureServiceEnabled(serviceType)) {
			return false;
		}
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		const classes = this.serviceTypes.get(key);
		return classes !== undefined && classes.length > 0;
	}

	/**
	 * Get the registration status of a service
	 * @param serviceType - The service type to check
	 * @returns the current registration status
	 */
	getServiceRegistrationStatus(
		serviceType: ServiceTypeName | string,
	): "pending" | "registering" | "registered" | "failed" | "unknown" {
		if (!this.isNativeFeatureServiceEnabled(serviceType)) {
			return "unknown";
		}
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		return this.serviceRegistrationStatus.get(key) || "unknown";
	}

	/**
	 * Get service health information
	 * @returns Object containing service health status
	 */
	getServiceHealth(): Record<
		string,
		{
			status: "pending" | "registering" | "registered" | "failed" | "unknown";
			instances: number;
			hasPromise: boolean;
		}
	> {
		const health: Record<
			string,
			{
				status: "pending" | "registering" | "registered" | "failed" | "unknown";
				instances: number;
				hasPromise: boolean;
			}
		> = {};

		// Check all registered services
		for (const [serviceType, instances] of this.services) {
			health[serviceType] = {
				status: this.getServiceRegistrationStatus(serviceType),
				instances: instances.length,
				hasPromise: this.servicePromises.has(serviceType),
			};
		}

		// Check services that have registration status but no instances yet
		for (const [serviceType, status] of this.serviceRegistrationStatus) {
			if (!health[serviceType]) {
				health[serviceType] = {
					status,
					instances: 0,
					hasPromise: this.servicePromises.has(serviceType),
				};
			}
		}

		return health;
	}

	async registerService(serviceDef: ServiceClass): Promise<void> {
		const serviceType = serviceDef.serviceType as ServiceTypeName;
		const serviceName = (serviceDef as { name?: string }).name || "Unknown";

		if (!serviceType) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, serviceName },
				"Service missing serviceType property",
			);
			return;
		}
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, serviceType },
			"Registering service (lazy; start() on first getService)",
		);

		this.serviceRegistrationStatus.set(serviceType, "pending");
		if (!this.servicePromises.has(serviceType)) {
			this._createServiceResolver(serviceType);
		}
		if (!this.serviceTypes.has(serviceType)) {
			this.serviceTypes.set(serviceType, []);
		}
		const serviceClassList = this.serviceTypes.get(serviceType);
		if (!serviceClassList) {
			return;
		}
		serviceClassList.push(serviceDef);
	}

	/// ensures servicePromises & servicePromiseHandlers for a serviceType
	private _createServiceResolver(serviceType: ServiceTypeName | string) {
		let resolver: ServiceResolver | undefined;
		let rejecter: ServiceRejecter | undefined;
		const svcPromise = new Promise<Service>((resolve, reject) => {
			resolver = resolve;
			rejecter = reject;
		});
		// error-policy:J5 unhandled-rejection suppression — callers of
		// getServiceLoadPromise() still observe the rejection when they await;
		// this only prevents an unhandled rejection if the service fails first.
		svcPromise.catch(() => {});
		this.servicePromises.set(serviceType, svcPromise);
		if (!resolver) {
			throw new Error(`Failed to create resolver for service ${serviceType}`);
		}
		if (!rejecter) {
			throw new Error(`Failed to create rejecter for service ${serviceType}`);
		}
		this.servicePromiseHandlers.set(serviceType, {
			resolve: resolver,
			reject: rejecter,
		});
		const promise = this.servicePromises.get(serviceType);
		if (!promise) {
			throw new Error(`Service promise for ${serviceType} not found`);
		}
		return promise;
	}

	/// Returns a promise that resolves once this service is loaded (starts the service on first call).
	///
	/// Note: Plugins can register arbitrary service type strings; callers may
	/// therefore provide either a core `ServiceTypeName` or a plugin-defined string.
	getServiceLoadPromise(
		serviceType: ServiceTypeName | string,
	): Promise<Service> {
		const key = this.resolveServiceTypeAlias(serviceType) as ServiceTypeName;
		return this._ensureServiceStarted(key).then((s) => {
			if (!s)
				throw new Error(
					`Service ${String(serviceType)} not found or failed to start`,
				);
			return s;
		});
	}

	registerModel(
		modelType: ModelTypeName | string,
		handler: (
			runtime: IAgentRuntime,
			params: Record<string, JsonValue | object>,
		) => Promise<JsonValue | object>,
		provider: string,
		priority?: number,
		metadata?: ModelRegistrationMetadata,
	): void {
		const modelKey = String(modelType);
		if (!this.models.has(modelKey)) {
			this.models.set(modelKey, []);
		}

		const registrationOrder = Date.now();
		const modelsArray = this.models.get(modelKey);
		if (modelsArray) {
			modelsArray.push({
				handler,
				metadata,
				provider,
				priority: priority || 0,
				registrationOrder,
			});
			modelsArray.sort((a, b) => {
				if ((b.priority || 0) !== (a.priority || 0)) {
					return (b.priority || 0) - (a.priority || 0);
				}
				return (a.registrationOrder || 0) - (b.registrationOrder || 0);
			});
		}

		// Announce the registration so observers (e.g. the local-inference
		// routing table) can mirror the model registry without patching the
		// runtime or capturing handlers. Fire-and-forget: a no-op when nothing
		// is subscribed, and registry bookkeeping must never block boot.
		void this.emitEvent(EventType.MODEL_REGISTERED, {
			modelType: modelKey,
			metadata,
			provider,
			priority: priority || 0,
		});
	}

	/**
	 * Handler-free snapshot of every registered model handler, sorted by
	 * priority (descending) then registration order within each model type —
	 * the same order `getModel`/`useModel` select in. Exposes the private
	 * `models` map as metadata so hosts and observers can render a routing
	 * table or seed a mirror without touching handler functions. Pair with the
	 * {@link EventType.MODEL_REGISTERED} event to stay live.
	 */
	getModelRegistrations(): ModelRegistrationInfo[] {
		const out: ModelRegistrationInfo[] = [];
		for (const [modelType, handlers] of this.models) {
			for (const h of handlers) {
				out.push({
					modelType,
					metadata: h.metadata,
					provider: h.provider,
					priority: h.priority || 0,
					registrationOrder: h.registrationOrder || 0,
				});
			}
		}
		return out;
	}

	/**
	 * The runtime-selected text-model provider, or undefined to use the default
	 * (highest-priority) handler. Read from `ELIZA_BRAIN_PROVIDER` so an owner
	 * action that mutates `character.settings` (and/or persists it to config)
	 * flips the chat brain on the next model call with no restart. Returns
	 * undefined when the setting is empty OR names a provider that has no
	 * registered text handler, so a stale or mistyped value never strands the
	 * brain — it simply falls back to the default provider. The same contract
	 * holds at call time: useModel keeps the default-chain registrations behind
	 * the override as a failover tail, so a rate-limited/exhausted override
	 * provider falls to the registered backups instead of stranding the brain.
	 */
	/**
	 * Record the provider that served a successful `useModel` call, keyed by the
	 * requested model-type string. Only real (non-empty) provider names are
	 * stored so a caller reading it back never sees a fabricated value (#13623).
	 */
	private noteResolvedModelProvider(
		modelTypeKey: string,
		provider: string | undefined,
	): void {
		if (typeof provider === "string" && provider.trim().length > 0) {
			this.lastResolvedModelProviderByType.set(modelTypeKey, provider);
		}
	}

	/**
	 * The provider name that served the most recent successful `useModel` call
	 * for the given model type, or `undefined` if no such call has completed
	 * (so callers can fail-closed rather than fabricate a provider). Lets the
	 * trajectory stage recorders in `services/message.ts` name the real provider
	 * that answered the messageHandler / factsAndRelationships call instead of
	 * the hardcoded `"default"` literal (#13623).
	 */
	getLastResolvedModelProvider(
		modelType: ModelTypeName | string,
	): string | undefined {
		return this.lastResolvedModelProviderByType.get(String(modelType));
	}

	private resolveTextProviderOverride(): string | undefined {
		const raw = this.getSetting("ELIZA_BRAIN_PROVIDER");
		const override = typeof raw === "string" ? raw.trim() : "";
		if (!override) return undefined;
		const hasHandler = TEXT_GENERATION_MODEL_KEYS.some((key) =>
			this.models.get(key)?.some((m) => m.provider === override),
		);
		return hasHandler ? override : undefined;
	}

	private resolveModelRegistration(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration | undefined {
		return this.resolveModelRegistrations(modelType, provider)[0];
	}

	private resolveModelRegistrations(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration[] {
		const requestedModelKey = String(modelType);
		const resolvedModels: ResolvedModelRegistration[] = [];

		for (const candidateKey of getModelFallbackChain(requestedModelKey)) {
			const models = this.models.get(candidateKey);
			if (!models?.length) {
				continue;
			}

			const modelWithProvider =
				provider && models.find((model) => model.provider === provider);
			const candidateModels = provider
				? modelWithProvider
					? [modelWithProvider]
					: []
				: models;

			for (const resolvedModel of candidateModels) {
				if (candidateKey !== requestedModelKey) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							requestedModel: requestedModelKey,
							resolvedModel: candidateKey,
							provider: resolvedModel.provider,
						},
						"Model fallback applied",
					);
				}

				resolvedModels.push({
					handler: resolvedModel.handler,
					metadata: resolvedModel.metadata,
					modelKey: candidateKey,
					provider: resolvedModel.provider,
				});
			}

			if (provider && candidateModels.length > 0) {
				break;
			}
		}

		return resolvedModels;
	}

	private logModelProviderFailover(args: {
		requestedModelKey: string;
		failedModel: ResolvedModelRegistration;
		nextModel: ResolvedModelRegistration;
		error: unknown;
	}): void {
		this.logger.warn(
			{
				src: "agent",
				agentId: this.agentId,
				requestedModel: args.requestedModelKey,
				failedModel: args.failedModel.modelKey,
				failedProvider: args.failedModel.provider,
				nextModel: args.nextModel.modelKey,
				nextProvider: args.nextModel.provider,
				error:
					args.error instanceof Error ? args.error.message : String(args.error),
			},
			"Model provider failed; trying next registered provider",
		);
	}

	private shouldFailOverModelProvider(
		error: unknown,
		modelType: string,
	): boolean {
		return isModelProviderFallbackError(error, modelType);
	}

	private throwNoModelHandler(requestedModelKey: string): never {
		// If the request is for a text-generation model AND no text-generation
		// handler is registered for ANY of the text model types, this is the
		// "no LLM provider configured at all" state — surface a typed error
		// so callers (chat UI, etc.) can render an actionable hint instead of
		// a generic "No handler found for delegate type" parse-failure message.
		// Issue: elizaOS/eliza#7203.
		if (TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey)) {
			const hasAnyTextHandler = TEXT_GENERATION_MODEL_KEYS.some((key) => {
				const handlers = this.models.get(key);
				return Array.isArray(handlers) && handlers.length > 0;
			});
			if (!hasAnyTextHandler) {
				throw new NoModelProviderConfiguredError();
			}
		}
		throw new Error(`No handler found for delegate type: ${requestedModelKey}`);
	}

	/**
	 * Surface the failure that ends a `useModel` failover chain. A real `Error`
	 * with a message rethrows unchanged so provider SDK stack traces and typed
	 * subclasses (e.g. `NoModelProviderConfiguredError`, which the chat UI
	 * narrows on) survive the boundary. Everything else — the bare
	 * `{ status, error }` objects some providers/AI-SDK paths throw, or a
	 * message-less `Error` — becomes an `ElizaError` whose message names the
	 * provider, HTTP status, and underlying cause. Without this, a bare object
	 * stringified to the diagnostically useless "[object Object]" in logs,
	 * trajectories, and any user-surfaced failure text.
	 */
	private rethrowModelFailoverError(
		error: unknown,
		failed?: { modelKey: string; provider: string },
	): never {
		if (error instanceof Error && error.message.trim().length > 0) {
			throw error;
		}
		const detail = describeModelCallError(error);
		const provider = failed?.provider ?? "unknown";
		throw new ElizaError(`Model provider "${provider}" failed: ${detail}`, {
			code: "MODEL_PROVIDER_FAILED",
			cause: error,
			context: { provider: failed?.provider, modelKey: failed?.modelKey },
			severity: "ephemeral",
		});
	}

	getModel(
		modelType: ModelTypeName | string,
	):
		| ((
				runtime: IAgentRuntime,
				params: Record<string, JsonValue | object>,
		  ) => Promise<JsonValue | object>)
		| undefined {
		const resolvedModel = this.resolveModelRegistration(modelType);
		if (!resolvedModel) {
			return undefined;
		}

		// Return highest priority handler (first in array after sorting)
		return resolvedModel.handler;
	}

	/**
	 * Retrieves model configuration settings from character settings with support for
	 * model-specific overrides and default fallbacks.
	 *
	 * Precedence order (highest to lowest):
	 * 1. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
	 * 2. Default settings (e.g., DEFAULT_TEMPERATURE)
	 *
	 * @param modelType The specific model type to get settings for
	 * @returns Object containing model parameters if they exist, or null if no settings are configured
	 */
	private getModelSettings(
		modelType?: ModelTypeName,
	): Record<string, number> | null {
		const modelSettings: Record<string, number> = {};

		// Helper to get a setting value with fallback chain
		const getSettingWithFallback = (
			param:
				| "MAX_TOKENS"
				| "TEMPERATURE"
				| "TOP_P"
				| "TOP_K"
				| "MIN_P"
				| "SEED"
				| "REPETITION_PENALTY"
				| "FREQUENCY_PENALTY"
				| "PRESENCE_PENALTY",
		): number | null => {
			// Try model-specific setting first
			if (modelType) {
				const modelSpecificKey = `${modelType}_${param}`;
				const modelValue = this.getSetting(modelSpecificKey);
				if (modelValue !== null && modelValue !== undefined) {
					const numValue = Number(modelValue);
					if (!Number.isNaN(numValue)) {
						return numValue;
					}
				}
			}

			// Fall back to default setting
			const defaultKey = `DEFAULT_${param}`;
			const defaultValue = this.getSetting(defaultKey);
			if (defaultValue !== null && defaultValue !== undefined) {
				const numValue = Number(defaultValue);
				if (!Number.isNaN(numValue)) {
					return numValue;
				}
			}

			return null;
		};

		// Get settings with proper fallback chain
		const maxTokens = getSettingWithFallback("MAX_TOKENS");
		const temperature = getSettingWithFallback("TEMPERATURE");
		const topP = getSettingWithFallback("TOP_P");
		const topK = getSettingWithFallback("TOP_K");
		const minP = getSettingWithFallback("MIN_P");
		const seed = getSettingWithFallback("SEED");
		const repetitionPenalty = getSettingWithFallback("REPETITION_PENALTY");
		const frequencyPenalty = getSettingWithFallback("FREQUENCY_PENALTY");
		const presencePenalty = getSettingWithFallback("PRESENCE_PENALTY");

		// Add settings if they exist
		if (maxTokens !== null) modelSettings.maxTokens = maxTokens;
		if (temperature !== null) modelSettings.temperature = temperature;
		if (topP !== null) modelSettings.topP = topP;
		if (topK !== null) modelSettings.topK = topK;
		if (minP !== null) modelSettings.minP = minP;
		if (seed !== null) modelSettings.seed = seed;
		if (repetitionPenalty !== null)
			modelSettings.repetitionPenalty = repetitionPenalty;
		if (frequencyPenalty !== null)
			modelSettings.frequencyPenalty = frequencyPenalty;
		if (presencePenalty !== null)
			modelSettings.presencePenalty = presencePenalty;

		// Return null if no settings were configured
		return Object.keys(modelSettings).length > 0 ? modelSettings : null;
	}

	/**
	 * Helper to log model calls to the database (used by both streaming and non-streaming paths)
	 */
	private buildRuntimeSystemPrompt(): string | undefined {
		const prompt = buildCanonicalSystemPrompt({
			character: this.character,
			userRole: getTrajectoryContext()?.userRole,
		});
		return prompt || undefined;
	}

	private attachEffectiveSystemPrompt(
		modelKey: string,
		params: unknown,
	): string | undefined {
		if (
			!TEXT_GENERATION_MODEL_KEYS.includes(modelKey) ||
			!isPlainObject(params)
		) {
			return undefined;
		}
		const paramsRecord = params as Record<
			string,
			JsonValue | object | undefined
		>;
		const systemPrompt = resolveEffectiveSystemPrompt({
			params,
			fallback: this.buildRuntimeSystemPrompt(),
		});
		if (systemPrompt !== undefined && !Object.hasOwn(paramsRecord, "system")) {
			paramsRecord.system = systemPrompt;
		}
		return systemPrompt;
	}

	private getFirstUserPromptFromMessages(
		messages: unknown,
	): string | undefined {
		if (!Array.isArray(messages)) {
			return undefined;
		}
		for (const message of messages) {
			if (!message || typeof message !== "object" || Array.isArray(message)) {
				continue;
			}
			const record = message as { role?: unknown; content?: unknown };
			if (record.role !== "user") {
				continue;
			}
			const content = textFromChatMessageContent(record.content);
			if (content) {
				return content;
			}
		}
		return undefined;
	}

	private logModelCall(
		modelType: string,
		modelKey: string,
		_params: unknown,
		promptContent: string | null,
		systemPrompt: string | undefined,
		elapsedTime: number,
		provider: string | undefined,
		response: unknown,
	): void {
		// Per-turn latency breakdown: attribute this model round-trip to the
		// active inference timer (no-op when none is active). `elapsedTime` is the
		// already-measured handler+stream duration, so every return path that
		// funnels through here is covered exactly once.
		const resolvedProvider =
			provider || this.models.get(modelKey)?.[0]?.provider || "unknown";
		recordInferenceSpan(`model:${modelType}`, elapsedTime, {
			modelKey,
			provider: resolvedProvider,
		});
		if (modelType !== ModelType.TEXT_EMBEDDING) {
			setInferenceModelProvider(resolvedProvider);
		}
		// Log to database
		const responseValue =
			Array.isArray(response) && response.every((x) => typeof x === "number")
				? "[array]"
				: typeof response === "string"
					? response
					: undefined;
		void this.adapter
			.createLogs([
				{
					entityId: this.agentId,
					roomId: this.currentRoomId ?? this.agentId,
					body: {
						modelType,
						modelKey,
						prompt: promptContent ?? undefined,
						systemPrompt,
						runId: this.getCurrentRunId(),
						timestamp: Date.now(),
						executionTime: elapsedTime,
						provider:
							provider || this.models.get(modelKey)?.[0]?.provider || "unknown",
						response: responseValue,
					},
					type: `useModel:${modelKey}`,
				},
			])
			.catch((error) => {
				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						model: modelKey,
						error: error instanceof Error ? error.message : String(error),
					},
					"Model call log write failed",
				);
			});
	}

	async useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
		modelType: T,
		params: ModelParamsMap[T],
		provider?: string,
	): Promise<R> {
		const lookupCaller = RUNTIME_DEBUG_LOG_ENABLED
			? captureModelLookupCaller()
			: undefined;
		// Per-action model routing seam (closes A5 / W1-R2). If the call
		// originates inside an action handler that declared a `modelClass`, and
		// the requested model type is a text-generation model, we resolve
		// through a strategy chain instead of the default per-provider path.
		// The chain implements cost-aware ascending fallback: LOCAL → SMALL → LARGE.
		// Lookup the strategy ourselves rather than recursing on the requested
		// modelType so the routing decision is made once at the entry point,
		// not on every nested call.
		const actionRoutingCtx = getActionRoutingContext();
		if (actionRoutingCtx?.modelClass !== undefined && provider === undefined) {
			const strategy = maybeReroute(
				actionRoutingCtx.modelClass,
				String(modelType),
			);
			if (strategy) {
				const resolvedChain = resolveChain(strategy, (key) =>
					this.models.get(key),
				);
				if (resolvedChain.length > 0) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							action: actionRoutingCtx.actionName,
							modelClass: actionRoutingCtx.modelClass,
							requestedModelType: String(modelType),
							chain: resolvedChain.map((r) => ({
								modelType: r.modelType,
								provider: r.provider,
							})),
						},
						"Per-action model routing applied",
					);
					// Execute the chain. Each step recurses into useModel with the
					// resolved modelType + provider hint, but the action routing
					// context is cleared so the inner call uses the default path.
					return executeChainWithFallback(
						resolvedChain,
						strategy.confidenceThreshold,
						async (resolved) =>
							runWithoutActionRoutingContext(() =>
								this.useModel<T, R>(
									resolved.modelType as T,
									params,
									resolved.provider,
								),
							),
					);
				}
				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						action: actionRoutingCtx.actionName,
						modelClass: actionRoutingCtx.modelClass,
						requestedModelType: String(modelType),
					},
					"Per-action model routing requested but no handlers in chain — falling back to default",
				);
			}
		}

		let requestedModelKey = String(modelType);

		// Apply LLM mode override for text generation models
		const llmMode = this.getLLMMode();
		if (llmMode !== "DEFAULT") {
			// List of text generation model types that can be overridden
			const textGenerationModels = [
				ModelType.TEXT_NANO,
				ModelType.TEXT_SMALL,
				ModelType.TEXT_MEDIUM,
				ModelType.TEXT_LARGE,
				ModelType.TEXT_MEGA,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.TEXT_COMPLETION,
			];

			if (
				textGenerationModels.includes(
					requestedModelKey as (typeof textGenerationModels)[number],
				)
			) {
				const overrideModelKey =
					llmMode === "SMALL" ? ModelType.TEXT_SMALL : ModelType.TEXT_LARGE;
				if (requestedModelKey !== overrideModelKey) {
					this.logger.debug(
						{
							src: "agent",
							agentId: this.agentId,
							originalModel: requestedModelKey,
							overrideModel: overrideModelKey,
							llmMode,
						},
						"LLM mode override applied",
					);
					requestedModelKey = overrideModelKey as typeof requestedModelKey;
				}
			}
		}

		// TEXT_EMBEDDING calls without an explicit provider are pinned to the
		// provider that answered the dimension probe: the vector column was sized
		// from its output, so serving an embedding call from any other
		// registration (including via rate-limit failover) can emit a
		// different-width vector that the SQL adapter silently drops (#8769).
		// Pinning also disables mid-call provider failover for embeddings — an
		// embedding either comes from the provider the column was sized for, or
		// the call fails loudly. An explicit provider argument still wins.
		const requestedProvider =
			provider === undefined &&
			requestedModelKey === ModelType.TEXT_EMBEDDING &&
			this.pinnedEmbeddingProvider !== undefined
				? this.pinnedEmbeddingProvider
				: provider;

		// Runtime preferred-provider override: when the caller did not pin a
		// provider and this is a text-generation model, honor the runtime-selected
		// provider (ELIZA_BRAIN_PROVIDER). This lets an owner flip the chat brain
		// between loaded providers with no restart. It is a hint only — if that
		// provider resolves no handlers for this model the default chain is used
		// instead (see resolveTextProviderOverride), so the override can never
		// strand the brain. Unset → byte-identical to prior behavior.
		const providerOverride =
			provider === undefined &&
			TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey)
				? this.resolveTextProviderOverride()
				: undefined;
		const overrideResolved = providerOverride
			? this.resolveModelRegistrations(requestedModelKey, providerOverride)
			: [];
		// The override provider goes FIRST, but the remaining default-chain
		// registrations stay behind it as the failover tail. Without the tail a
		// rate-limited override provider strands the brain (its throw has no next
		// registration to fall to) even though healthy backup providers are
		// registered — violating the "never strands the brain" contract of
		// resolveTextProviderOverride. The failover loop below still only
		// advances on fallback-class errors, so a healthy pinned provider keeps
		// winning every call.
		const resolvedModels =
			overrideResolved.length > 0
				? [
						...overrideResolved,
						...this.resolveModelRegistrations(
							requestedModelKey,
							requestedProvider,
						).filter(
							(candidate) =>
								!overrideResolved.some(
									(chosen) =>
										chosen.handler === candidate.handler &&
										chosen.modelKey === candidate.modelKey,
								),
						),
					]
				: this.resolveModelRegistrations(requestedModelKey, requestedProvider);
		if (resolvedModels.length === 0) {
			this.throwNoModelHandler(requestedModelKey);
		}

		let lastModelError: unknown;
		let providerAttemptStartedOutput = false;
		for (
			let resolvedIndex = 0;
			resolvedIndex < resolvedModels.length;
			resolvedIndex++
		) {
			const resolvedModel = resolvedModels[resolvedIndex];
			if (!resolvedModel) {
				continue;
			}
			const resolvedModelKey = resolvedModel.modelKey;
			const handler = resolvedModel.handler;
			providerAttemptStartedOutput = false;

			try {
				const binaryModels: string[] = [
					ModelType.TRANSCRIPTION,
					ModelType.IMAGE,
					ModelType.AUDIO,
					ModelType.VIDEO,
				];
				// PII swap skips binary-input modalities (nothing to swap) and TEXT_EMBEDDING
				// (a random per-turn surrogate would destabilize embeddings), but — unlike
				// the secret gate — swaps IMAGE prompts, whose text can carry real names.
				const PII_SWAP_SKIP_MODELS: string[] = [
					ModelType.TRANSCRIPTION,
					ModelType.AUDIO,
					ModelType.VIDEO,
					ModelType.TEXT_EMBEDDING,
				];
				let modelParams: ModelParamsMap[T];
				const paramsClone = isPlainObject(params)
					? { ...(params as Record<string, JsonValue | object>) }
					: params;
				if (
					params === null ||
					params === undefined ||
					typeof params !== "object" ||
					Array.isArray(params) ||
					BufferUtils.isBuffer(params)
				) {
					modelParams = paramsClone as ModelParamsMap[T];
				} else {
					// Include model settings from character configuration if available
					const modelSettings = this.getModelSettings(requestedModelKey);

					if (modelSettings) {
						// Apply model settings if configured — merged object is narrowed at handlers after routing.
						const merged: object = {
							...modelSettings,
							...(paramsClone as Record<string, JsonValue | object>),
						};
						modelParams = merged as ModelParamsMap[T];
					} else {
						// No model settings configured, use params as-is
						modelParams = paramsClone as ModelParamsMap[T];
					}

					// Auto-populate user parameter from character name if not provided
					// The `user` parameter is used by LLM providers for tracking and analytics purposes.
					// We only auto-populate when user is undefined (not explicitly set to empty string or null)
					// to allow users to intentionally set an empty identifier if needed.
					const shouldAttachUser =
						requestedModelKey === ModelType.TEXT_NANO ||
						requestedModelKey === ModelType.TEXT_SMALL ||
						requestedModelKey === ModelType.TEXT_MEDIUM ||
						requestedModelKey === ModelType.TEXT_LARGE ||
						requestedModelKey === ModelType.TEXT_MEGA ||
						requestedModelKey === ModelType.RESPONSE_HANDLER ||
						requestedModelKey === ModelType.ACTION_PLANNER ||
						requestedModelKey === ModelType.TEXT_REASONING_SMALL ||
						requestedModelKey === ModelType.TEXT_REASONING_LARGE ||
						requestedModelKey === ModelType.TEXT_COMPLETION;
					if (
						shouldAttachUser &&
						isPlainObject(modelParams) &&
						this.character.name
					) {
						const modelParamsRecord = modelParams as Record<
							string,
							JsonValue | object
						>;
						if (modelParamsRecord.user === undefined) {
							modelParamsRecord.user = this.character.name;
						}
					}
				}
				const startTime =
					typeof performance !== "undefined" &&
					typeof performance.now === "function"
						? performance.now()
						: Date.now();

				// Get streaming config
				// Define interface for params that may have streaming properties
				interface StreamingParams {
					stream?: boolean;
					onStreamChunk?: StreamChunkCallback;
					signal?: AbortSignal;
					streamStructured?: boolean;
					responseSkeleton?: ResponseSkeleton;
				}
				const streamingCtx = getStreamingContext();
				const paramsAsStreaming = isPlainObject(modelParams)
					? (modelParams as StreamingParams)
					: undefined;
				const paramsChunk = paramsAsStreaming?.onStreamChunk;
				const ctxChunk = streamingCtx?.onStreamChunk;
				const msgId = streamingCtx?.messageId;
				const abortSignal = streamingCtx?.abortSignal;
				const explicitStream = paramsAsStreaming?.stream;
				const resolvedProviderName = resolvedModel?.provider;
				// stream: false = force no stream, otherwise stream if any callback exists.
				// Vision describes are often hidden preprocessing/OCR calls inside a chat
				// turn; do not leak those chunks into the visible chat stream unless the
				// call itself opts in.
				const requiresExplicitStreaming =
					requestedModelKey === ModelType.IMAGE_DESCRIPTION;
				const shouldStream =
					explicitStream === false
						? false
						: requiresExplicitStreaming
							? explicitStream === true
							: !!(paramsChunk || ctxChunk || explicitStream);
				const structuredStreamFields =
					shouldStream && paramsAsStreaming?.streamStructured === true
						? resolveResponseSkeletonStreamFields(
								paramsAsStreaming.responseSkeleton,
							)
						: [];
				const downstreamChunk = (chunk: string, accumulated?: string): void => {
					void (async () => {
						if (paramsChunk) await paramsChunk(chunk, msgId, accumulated);
						if (ctxChunk) await ctxChunk(chunk, msgId, accumulated);
					})();
				};
				const structuredExtractor =
					structuredStreamFields.length > 0 &&
					paramsAsStreaming?.responseSkeleton
						? new ResponseSkeletonStreamExtractor({
								skeleton: paramsAsStreaming.responseSkeleton,
								streamFields: structuredStreamFields,
								unordered: true,
								onChunk: (chunk, _field, accumulated) =>
									downstreamChunk(chunk, accumulated),
								...(abortSignal ? { abortSignal } : {}),
							})
						: undefined;
				let handlerDeliveredStream = false;
				let streamedText = "";
				let secretSwapSession: SecretSwapSession | null = null;
				let guardedStreamBuffer = "";
				let piiSwapSession: PseudonymSession | null = null;
				const emitModelStreamChunk = async (
					safeChunk: string,
					visibleChunk = safeChunk,
				): Promise<void> => {
					if (abortSignal?.aborted) return;
					if (safeChunk.length > 0) {
						providerAttemptStartedOutput = true;
					}
					if (streamedText === "" && safeChunk.length > 0) {
						markInference(INFERENCE_MARKS.firstToken);
					}
					streamedText += safeChunk;
					const trajStream = getTrajectoryContext();
					await this.invokePipelineHooks(
						"model_stream_chunk",
						modelStreamChunkPipelineHookContext({
							source: "use_model",
							chunk: safeChunk,
							messageId: msgId,
							roomId:
								(trajStream?.roomId as UUID | undefined) ??
								this.currentRoomId ??
								this.agentId,
							runId: this.getCurrentRunId(),
							...(trajStream?.messageId
								? { responseId: trajStream.messageId as UUID }
								: {}),
							accumulated: streamedText,
						}),
						"Model stream chunk (useModel)",
						false,
					);
					await runInsideModelStreamChunkDelivery(async () => {
						if (structuredExtractor) {
							structuredExtractor.push(visibleChunk);
							return;
						}
						if (paramsChunk) await paramsChunk(visibleChunk, msgId, undefined);
						if (ctxChunk) await ctxChunk(visibleChunk, msgId, undefined);
					});
				};
				const deliverModelStreamChunk = async (
					chunk: string,
				): Promise<void> => {
					if (abortSignal?.aborted) return;
					if (secretSwapSession || piiSwapSession) {
						guardedStreamBuffer += chunk;
						return;
					}
					await emitModelStreamChunk(chunk);
				};
				const flushGuardedStream = async (): Promise<void> => {
					if (
						abortSignal?.aborted ||
						(!secretSwapSession && !piiSwapSession) ||
						guardedStreamBuffer.length === 0
					) {
						return;
					}
					let safeText = guardedStreamBuffer;
					guardedStreamBuffer = "";
					if (secretSwapSession) {
						safeText = secretSwapSession.substituteText(safeText);
					}
					if (piiSwapSession) {
						safeText = piiSwapSession.substituteText(safeText);
					}
					if (safeText.length > 0) {
						const visibleText = piiSwapSession
							? piiSwapSession.restoreText(safeText)
							: safeText;
						await emitModelStreamChunk(safeText, visibleText);
					}
				};
				// Wire the handler-facing stream callback for registrations that declare
				// handler streaming support, with local-provider recognition retained as
				// the legacy fallback. The prefer-local router ("eliza-router") still opts
				// in by name because it forwards `onStreamChunk` to the underlying
				// on-device handler after routing.
				const declaredStreamable = resolvedModel.metadata?.streamable;
				const resolvedAcceptsHandlerStream =
					resolvedProviderName === "eliza-router" ||
					(typeof declaredStreamable === "boolean"
						? declaredStreamable
						: !!resolvedProviderName &&
							isLocalHandler({
								provider: resolvedProviderName,
								metadata: resolvedModel.metadata,
							}));
				const handlerStreamChunk: StreamChunkCallback | undefined =
					shouldStream &&
					resolvedAcceptsHandlerStream &&
					(paramsChunk || ctxChunk || structuredExtractor)
						? async (chunk) => {
								handlerDeliveredStream = true;
								await deliverModelStreamChunk(chunk);
							}
						: undefined;

				if (isPlainObject(modelParams) && paramsAsStreaming) {
					paramsAsStreaming.stream = shouldStream;
					if (handlerStreamChunk) {
						paramsAsStreaming.onStreamChunk = handlerStreamChunk;
					} else {
						delete paramsAsStreaming.onStreamChunk;
					}
					// Plumb the streaming-context abort signal into model params so the
					// underlying handler can wire it into its transport (e.g. local
					// llama's `stopOnAbortSignal`, fetch's `signal`). Only inject when
					// the caller didn't already pass one explicitly.
					if (paramsAsStreaming.signal === undefined && abortSignal) {
						paramsAsStreaming.signal = abortSignal;
					}
				}

				const textModelKey = TEXT_GENERATION_MODEL_KEYS.includes(
					String(resolvedModelKey),
				)
					? String(resolvedModelKey)
					: requestedModelKey;
				let effectiveSystemPrompt = this.attachEffectiveSystemPrompt(
					textModelKey,
					modelParams,
				);

				if (
					this.isSecretSwapEnabled() &&
					!binaryModels.includes(resolvedModelKey)
				) {
					// Reuse one session per turn so every model call in the turn shares a
					// nonce and the action-execution boundary can restore what this call
					// swapped. The session hangs off the turn-scoped trajectory context;
					// calls outside a trajectory scope fall back to a per-call session
					// (no egress restore — there is no execution boundary to restore at).
					const trajectoryCtx = getTrajectoryContext();
					secretSwapSession =
						trajectoryCtx?.secretSwapSession ?? this.createSecretSwapSession();
					if (trajectoryCtx && !trajectoryCtx.secretSwapSession) {
						trajectoryCtx.secretSwapSession = secretSwapSession;
					}
					modelParams = secretSwapSession.substituteInValue(modelParams);
					effectiveSystemPrompt =
						effectiveSystemPrompt === undefined
							? undefined
							: secretSwapSession.substituteText(effectiveSystemPrompt);
				}

				// Models the PII swap must NOT touch: binary-input modalities (nothing to
				// swap) and — unlike the secret gate — IMAGE is INCLUDED (its text prompt
				// can carry real names), while TEXT_EMBEDDING is EXCLUDED (a per-turn-random
				// surrogate would embed the same real text differently every turn and wreck
				// semantic memory retrieval; embeddings stay on the real text).
				let piiIngressText = "";
				if (
					this.isPiiSwapEnabled() &&
					!PII_SWAP_SKIP_MODELS.includes(resolvedModelKey)
				) {
					// Turn-scoped like the secret session (same mapping all turn), so the
					// execution boundary can restore what this call swapped.
					const trajectoryCtx = getTrajectoryContext();
					piiSwapSession =
						trajectoryCtx?.piiSwapSession ?? this.createPiiSwapSession();
					if (trajectoryCtx && !trajectoryCtx.piiSwapSession) {
						trajectoryCtx.piiSwapSession = piiSwapSession;
					}
					// The awaited detection step: learn every named entity in the assembled
					// prompt (params + system prompt), then substitute synchronously. Ordered
					// after the secret pass, so the NER model reads opaque
					// `__ELIZA_SECRET_…__` placeholders, never a raw secret. The ONNX
					// inference is offloaded to onnxruntime's threadpool, so it overlaps the
					// event loop rather than blocking other turns.
					piiIngressText = this.collectPromptText(
						modelParams,
						effectiveSystemPrompt,
					);
					await piiSwapSession.learn(piiIngressText);
					modelParams = piiSwapSession.substituteInValue(modelParams);
					effectiveSystemPrompt =
						effectiveSystemPrompt === undefined
							? undefined
							: piiSwapSession.substituteText(effectiveSystemPrompt);
				}

				await this.invokePipelineHooks(
					"pre_model",
					preModelPipelineHookContext({
						requestedModelType: String(modelType),
						resolvedModelKey,
						provider: resolvedModel.provider,
						roomId: getTrajectoryContext()?.roomId,
						params: modelParams,
					}),
					"Pre-model pipeline hook",
				);
				if (secretSwapSession) {
					modelParams = secretSwapSession.substituteInValue(modelParams);
					const postHookSystemPrompt = resolveEffectiveSystemPrompt({
						params: modelParams,
						fallback: effectiveSystemPrompt,
					});
					effectiveSystemPrompt =
						postHookSystemPrompt === undefined
							? undefined
							: secretSwapSession.substituteText(postHookSystemPrompt);
				}
				if (piiSwapSession) {
					// pre_model hooks may have injected fresh text (RAG snippets, extra
					// context) with never-seen PII. If the assembled text changed, re-run
					// detection so that new PII is swapped too — not just already-learned
					// values re-masked. learn() is idempotent, so this only adds new entities.
					const postHookText = this.collectPromptText(
						modelParams,
						effectiveSystemPrompt,
					);
					if (postHookText !== piiIngressText) {
						await piiSwapSession.learn(postHookText);
					}
					modelParams = piiSwapSession.substituteInValue(modelParams);
					const postHookSystemPrompt = resolveEffectiveSystemPrompt({
						params: modelParams,
						fallback: effectiveSystemPrompt,
					});
					effectiveSystemPrompt =
						postHookSystemPrompt === undefined
							? undefined
							: piiSwapSession.substituteText(postHookSystemPrompt);
				}

				const hookedParamsObj =
					modelParams &&
					typeof modelParams === "object" &&
					!Array.isArray(modelParams)
						? (modelParams as Record<string, JsonValue | object>)
						: null;
				const promptContent =
					(hookedParamsObj &&
					"prompt" in hookedParamsObj &&
					typeof hookedParamsObj.prompt === "string"
						? hookedParamsObj.prompt
						: null) ||
					(hookedParamsObj &&
					"input" in hookedParamsObj &&
					typeof hookedParamsObj.input === "string"
						? hookedParamsObj.input
						: null) ||
					(hookedParamsObj &&
					"messages" in hookedParamsObj &&
					Array.isArray(hookedParamsObj.messages)
						? stringifyStructuredForPrompt({
								messages: hookedParamsObj.messages,
							})
						: null) ||
					(typeof modelParams === "string" ? modelParams : null);

				if (!binaryModels.includes(resolvedModelKey)) {
					this.logger.trace(
						{
							src: "agent",
							agentId: this.agentId,
							model: resolvedModelKey,
							params: modelParams,
						},
						"Model input",
					);
				} else {
					let sizeInfo = "unknown size";
					if (Buffer.isBuffer(modelParams)) {
						sizeInfo = `${modelParams.length} bytes`;
					} else if (
						typeof Blob !== "undefined" &&
						modelParams instanceof Blob
					) {
						sizeInfo = `${modelParams.size} bytes`;
					} else if (typeof modelParams === "object" && modelParams !== null) {
						if ("audio" in modelParams && Buffer.isBuffer(modelParams.audio)) {
							sizeInfo = `${(modelParams.audio as Buffer).length} bytes`;
						} else if (
							"audio" in modelParams &&
							typeof Blob !== "undefined" &&
							modelParams.audio instanceof Blob
						) {
							sizeInfo = `${(modelParams.audio as Blob).size} bytes`;
						}
					}
					this.logger.trace(
						{
							src: "agent",
							agentId: this.agentId,
							model: resolvedModelKey,
							size: sizeInfo,
						},
						"Model input (binary)",
					);
				}

				this.logger.debug(
					{
						src: "agent",
						agentId: this.agentId,
						model: resolvedModelKey,
						provider: resolvedModel.provider,
						...(lookupCaller?.caller ? { caller: lookupCaller.caller } : {}),
						...(lookupCaller?.callerStack.length
							? { callerStack: lookupCaller.callerStack }
							: {}),
					},
					"Using model",
				);

				const rawResponse = await handler(
					this,
					modelParams as Record<string, JsonValue | object>,
				);

				let safeRawResponse: unknown =
					secretSwapSession?.substituteInValue(rawResponse) ?? rawResponse;
				safeRawResponse =
					piiSwapSession?.substituteInValue(safeRawResponse) ?? safeRawResponse;
				const resultRef: { current: unknown } = { current: safeRawResponse };
				const modelOutToTrajectoryString = (v: unknown) =>
					typeof v === "string"
						? v
						: stringifyStructuredForPrompt({ response: v });

				// Stream: broadcast to callbacks if streaming
				if (
					shouldStream &&
					(paramsChunk || ctxChunk) &&
					isTextStreamResult(rawResponse)
				) {
					for await (const chunk of rawResponse.textStream) {
						if (abortSignal?.aborted) break;
						await deliverModelStreamChunk(chunk);
					}
					await flushGuardedStream();
					structuredExtractor?.flush();

					const trajStreamEnd = getTrajectoryContext();
					await this.invokePipelineHooks(
						"model_stream_end",
						modelStreamEndPipelineHookContext({
							source: "use_model",
							roomId:
								(trajStreamEnd?.roomId as UUID | undefined) ??
								this.currentRoomId ??
								this.agentId,
							runId: this.getCurrentRunId(),
							messageId: msgId ?? trajStreamEnd?.messageId,
							text: streamedText,
						}),
						"Model stream end (useModel)",
						true,
					);

					// Signal stream end to allow context to reset state between useModel calls
					const streamingCtxEnd = getStreamingContext();
					const ctxEnd = streamingCtxEnd?.onStreamEnd;
					if (ctxEnd) ctxEnd();

					// Preserve tool calls + finishReason + usage from the stream result.
					// The streaming branch used to collapse the response to `streamedText`
					// (a bare string), discarding any `toolCalls` surfaced by the provider
					// as a Promise. Callers like `parsePlannerOutput` then saw
					// `toolCalls.length === 0` and incremented `required_tool_misses` even
					// though the LLM had emitted a valid native tool call.
					const streamRaw = rawResponse as {
						toolCalls?: unknown;
						finishReason?: unknown;
						usage?: unknown;
						providerMetadata?: unknown;
					};
					const hasToolCallsField = "toolCalls" in streamRaw;
					const resolvedToolCalls = hasToolCallsField
						? await Promise.resolve(streamRaw.toolCalls).catch(() => [])
						: [];
					const hasResolvedToolCalls =
						Array.isArray(resolvedToolCalls) && resolvedToolCalls.length > 0;
					// Only widen to a GenerateText-shape result when the stream actually
					// surfaced tool calls. The original streaming contract returns a bare
					// string; the wider object exists solely to preserve `toolCalls` for
					// `parsePlannerOutput`, which is irrelevant when none were emitted.
					if (hasResolvedToolCalls) {
						const resolvedFinishReason =
							"finishReason" in streamRaw
								? await Promise.resolve(streamRaw.finishReason).catch(
										() => undefined,
									)
								: undefined;
						const resolvedUsage =
							"usage" in streamRaw
								? await Promise.resolve(streamRaw.usage).catch(() => undefined)
								: undefined;
						resultRef.current = {
							text: streamedText,
							toolCalls: resolvedToolCalls,
							finishReason: resolvedFinishReason,
							usage: resolvedUsage,
							providerMetadata: streamRaw.providerMetadata,
						};
					} else {
						resultRef.current = streamedText;
					}

					const elapsedTime =
						(typeof performance !== "undefined" &&
						typeof performance.now === "function"
							? performance.now()
							: Date.now()) - startTime;

					await this.invokePipelineHooks(
						"post_model",
						postModelPipelineHookContext({
							requestedModelType: String(modelType),
							resolvedModelKey,
							provider: resolvedModel.provider,
							roomId: getTrajectoryContext()?.roomId,
							durationMs: Math.round(elapsedTime),
							params: modelParams,
							result: resultRef,
							streaming: true,
						}),
						"Post-model pipeline hook",
					);
					resultRef.current =
						secretSwapSession?.substituteInValue(resultRef.current) ??
						resultRef.current;
					resultRef.current =
						piiSwapSession?.substituteInValue(resultRef.current) ??
						resultRef.current;

					// Record the provider that actually served this call so callers
					// that can't see the internal resolution (message.ts stage
					// recorders) can read the real provider instead of hardcoding
					// "default" (#13623).
					this.noteResolvedModelProvider(
						requestedModelKey,
						resolvedModel.provider,
					);

					this.logger.trace(
						{
							src: "agent",
							agentId: this.agentId,
							model: resolvedModelKey,
							duration: Number(elapsedTime.toFixed(2)),
							streaming: true,
						},
						"Model output (stream with callback complete)",
					);

					this.logModelCall(
						String(modelType),
						resolvedModelKey,
						modelParams,
						promptContent,
						effectiveSystemPrompt,
						elapsedTime,
						resolvedModel.provider,
						resultRef.current,
					);

					if (String(modelType) !== ModelType.TEXT_EMBEDDING) {
						await this.recordUseModelTrajectory({
							modelType: String(modelType),
							resolvedModelKey: String(resolvedModelKey),
							provider: resolvedModel.provider,
							modelParams,
							promptContent,
							result: resultRef.current,
							response: modelOutToTrajectoryString(resultRef.current),
							elapsedTime,
						});
					}

					return resultRef.current as R;
				}

				if (handlerDeliveredStream) {
					await flushGuardedStream();
					structuredExtractor?.flush();
					const trajStreamEnd = getTrajectoryContext();
					await this.invokePipelineHooks(
						"model_stream_end",
						modelStreamEndPipelineHookContext({
							source: "use_model",
							roomId:
								(trajStreamEnd?.roomId as UUID | undefined) ??
								this.currentRoomId ??
								this.agentId,
							runId: this.getCurrentRunId(),
							messageId: msgId ?? trajStreamEnd?.messageId,
							text: streamedText,
						}),
						"Model stream end (useModel)",
						true,
					);
					const streamingCtxEnd = getStreamingContext();
					const ctxEnd = streamingCtxEnd?.onStreamEnd;
					if (ctxEnd) ctxEnd();
				}

				const elapsedTime =
					(typeof performance !== "undefined" &&
					typeof performance.now === "function"
						? performance.now()
						: Date.now()) - startTime;

				await this.invokePipelineHooks(
					"post_model",
					postModelPipelineHookContext({
						requestedModelType: String(modelType),
						resolvedModelKey,
						provider: resolvedModel.provider,
						roomId: getTrajectoryContext()?.roomId,
						durationMs: Math.round(elapsedTime),
						params: modelParams,
						result: resultRef,
						streaming: handlerDeliveredStream,
					}),
					"Post-model pipeline hook",
				);
				resultRef.current =
					secretSwapSession?.substituteInValue(resultRef.current) ??
					resultRef.current;
				resultRef.current =
					piiSwapSession?.substituteInValue(resultRef.current) ??
					resultRef.current;

				// Record the provider that actually served this call so callers
				// that can't see the internal resolution (message.ts stage
				// recorders) can read the real provider instead of hardcoding
				// "default" (#13623).
				this.noteResolvedModelProvider(
					requestedModelKey,
					resolvedModel.provider,
				);

				this.logger.trace(
					{
						src: "agent",
						agentId: this.agentId,
						model: resolvedModelKey,
						duration: Number(elapsedTime.toFixed(2)),
					},
					"Model output",
				);

				this.logModelCall(
					String(modelType),
					resolvedModelKey,
					modelParams,
					promptContent,
					effectiveSystemPrompt,
					elapsedTime,
					resolvedModel.provider,
					resultRef.current,
				);

				if (String(modelType) !== ModelType.TEXT_EMBEDDING) {
					await this.recordUseModelTrajectory({
						modelType: String(modelType),
						resolvedModelKey: String(resolvedModelKey),
						provider: resolvedModel.provider,
						modelParams,
						promptContent,
						result: resultRef.current,
						response: modelOutToTrajectoryString(resultRef.current),
						elapsedTime,
					});
				}
				return resultRef.current as R;
			} catch (error) {
				lastModelError = error;
				const nextModel = resolvedModels[resolvedIndex + 1];
				if (
					requestedProvider !== undefined ||
					!nextModel ||
					providerAttemptStartedOutput ||
					!this.shouldFailOverModelProvider(error, requestedModelKey)
				) {
					this.rethrowModelFailoverError(error, {
						modelKey: resolvedModelKey,
						provider: resolvedModel.provider,
					});
				}
				this.logModelProviderFailover({
					requestedModelKey,
					failedModel: resolvedModel,
					nextModel,
					error,
				});
			}
		}
		this.rethrowModelFailoverError(
			lastModelError ??
				new Error(`No handler found for delegate type: ${requestedModelKey}`),
		);
	}

	/**
	 * Emit an llm-call entry against the current trajectory step for a
	 * `useModel` call. Pure dedupe of the streaming and non-streaming paths
	 * inside {@link useModel}; both paths formerly inlined an identical block.
	 *
	 * Skipped while the runtime is still initializing because
	 * {@link _ensureServiceStarted} awaits `initPromise` and would deadlock.
	 * Trajectory logging must never break core model flow, so any thrown
	 * error here is swallowed.
	 */
	private async recordUseModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		provider?: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		result?: unknown;
		response: string;
		elapsedTime: number;
	}): Promise<void> {
		if (this.initResolver) return;

		try {
			const trajCtx = getTrajectoryContext();
			const stepId = trajCtx?.trajectoryStepId;
			const trajLogger = (await this._ensureServiceStarted("trajectories")) as
				| (Service & TrajectoryRuntimeLlmCallLogger)
				| null;
			if (!stepId || !trajLogger) return;

			const tempRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { temperature?: number }).temperature
				: undefined;
			const maxTokensRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { maxTokens?: number }).maxTokens
				: undefined;
			const paramsRecord = isPlainObject(args.modelParams)
				? (args.modelParams as Record<string, unknown>)
				: {};
			const systemPrompt =
				resolveEffectiveSystemPrompt({
					params: args.modelParams,
					fallback: this.buildRuntimeSystemPrompt(),
				}) ?? "";
			const userPrompt =
				this.getFirstUserPromptFromMessages(paramsRecord.messages) ??
				args.promptContent ??
				"";
			const resultRecord = isPlainObject(args.result)
				? (args.result as Record<string, unknown>)
				: {};
			const usageRecord = isPlainObject(resultRecord.usage)
				? (resultRecord.usage as Record<string, unknown>)
				: {};
			const asNumber = (value: unknown): number | undefined =>
				typeof value === "number" && Number.isFinite(value) ? value : undefined;
			const activeTrace = this.getActiveTrace(this.getCurrentRunId());
			trajLogger.logLlmCall({
				stepId,
				model: args.resolvedModelKey,
				modelType: args.modelType,
				provider: args.provider,
				systemPrompt,
				userPrompt,
				prompt:
					typeof paramsRecord.prompt === "string"
						? paramsRecord.prompt
						: userPrompt,
				messages: Array.isArray(paramsRecord.messages)
					? paramsRecord.messages
					: undefined,
				tools: paramsRecord.tools,
				toolChoice: paramsRecord.toolChoice,
				responseSchema: paramsRecord.responseSchema,
				providerOptions: paramsRecord.providerOptions,
				response: args.response,
				toolCalls: Array.isArray(resultRecord.toolCalls)
					? resultRecord.toolCalls
					: undefined,
				finishReason:
					typeof resultRecord.finishReason === "string"
						? resultRecord.finishReason
						: undefined,
				providerMetadata: resultRecord.providerMetadata,
				temperature: typeof tempRaw === "number" ? tempRaw : 0,
				maxTokens: typeof maxTokensRaw === "number" ? maxTokensRaw : 0,
				purpose: trajCtx.purpose ?? "action",
				actionType: "runtime.useModel",
				latencyMs: Math.max(0, Math.round(args.elapsedTime)),
				promptTokens: asNumber(usageRecord.promptTokens),
				completionTokens: asNumber(usageRecord.completionTokens),
				cacheReadInputTokens: asNumber(usageRecord.cacheReadInputTokens),
				cacheCreationInputTokens: asNumber(
					usageRecord.cacheCreationInputTokens,
				),
				modelSlot: args.modelType,
				runId: trajCtx.runId,
				roomId: trajCtx.roomId,
				messageId: trajCtx.messageId,
				executionTraceId: activeTrace?.id,
				providerOrder: trajCtx.providerOrder,
				providerAttributions: trajCtx.providerAttributions,
			});
		} catch {
			// Trajectory logging must never break core model flow.
		}
	}

	/**
	 * Simplified text generation with optional character context.
	 */
	async generateText(
		input: string,
		options?: GenerateTextOptions,
	): Promise<GenerateTextResult> {
		if (!input.trim()) {
			throw new Error("Input cannot be empty");
		}

		// Set defaults
		const includeCharacter = options?.includeCharacter ?? true;
		const modelType = options?.modelType ?? ModelType.TEXT_LARGE;

		let prompt = input;
		let system: string | undefined;

		// Add character context if requested
		if (includeCharacter && this.character) {
			const c = this.character;
			const parts: string[] = [];

			system = this.buildRuntimeSystemPrompt();

			// Add style directives (all + chat)
			const styles = [...(c.style?.all || []), ...(c.style?.chat || [])];
			if (styles.length > 0) {
				parts.push(`Style:\n${styles.map((s) => `- ${s}`).join("\n")}`);
			}

			// Combine character context with input
			if (parts.length > 0) {
				prompt = `${parts.join("\n\n")}\n\n${input}`;
			}
		}

		const params: GenerateTextParams = {
			prompt,
			maxTokens: options?.maxTokens,
			minTokens: options?.minTokens,
			temperature: options?.temperature,
			topP: options?.topP,
			topK: options?.topK,
			minP: options?.minP,
			seed: options?.seed,
			repetitionPenalty: options?.repetitionPenalty,
			frequencyPenalty: options?.frequencyPenalty,
			presencePenalty: options?.presencePenalty,
			system,
			stopSequences: options?.stopSequences,
			// User identifier for provider tracking/analytics - auto-populates from character name if not provided
			// Explicitly set empty string or null will be preserved (not overridden)
			user:
				options && options.user !== undefined
					? options.user
					: this.character.name,
			responseFormat: options?.responseFormat,
		};

		const response = await this.useModel(modelType, params);

		return {
			text: response,
		};
	}

	// ============================================================================
	// Dynamic Prompt Execution with Validation-Aware Streaming
	// ============================================================================

	/**
	 * Performance metrics for dynamic prompt execution.
	 * Tracks success/failure rates per model+schema combination.
	 *
	 * Uses LRU-style eviction to prevent unbounded growth:
	 * - Max 100 entries (sufficient for typical model+schema combinations)
	 * - Entries older than 1 hour are pruned on access
	 */
	private static dynamicPromptMetrics = new Map<
		string,
		{
			lowestFailedTokenCount: number | null;
			highestSuccessTokenCount: number | null;
			totalAttempts: number;
			successfulAttempts: number;
			failedAttempts: number;
			lastUpdated: number;
		}
	>();

	private static readonly METRICS_MAX_ENTRIES = 100;
	private static readonly METRICS_TTL_MS = 60 * 60 * 1000; // 1 hour
	private static readonly STRUCTURED_FAILURE_PREVIEW_LIMIT = 4000;

	/**
	 * Get or create metrics entry with LRU eviction.
	 */
	private static getOrCreateMetrics(key: string) {
		const now = Date.now();

		// Prune stale entries periodically (when we access)
		if (
			AgentRuntime.dynamicPromptMetrics.size >
			AgentRuntime.METRICS_MAX_ENTRIES / 2
		) {
			for (const [k, v] of AgentRuntime.dynamicPromptMetrics) {
				if (now - v.lastUpdated > AgentRuntime.METRICS_TTL_MS) {
					AgentRuntime.dynamicPromptMetrics.delete(k);
				}
			}
		}

		// Evict oldest if still at max capacity
		if (
			AgentRuntime.dynamicPromptMetrics.size >= AgentRuntime.METRICS_MAX_ENTRIES
		) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [k, v] of AgentRuntime.dynamicPromptMetrics) {
				if (v.lastUpdated < oldestTime) {
					oldestTime = v.lastUpdated;
					oldestKey = k;
				}
			}
			if (oldestKey) {
				AgentRuntime.dynamicPromptMetrics.delete(oldestKey);
			}
		}

		let metric = AgentRuntime.dynamicPromptMetrics.get(key);
		if (!metric) {
			metric = {
				lowestFailedTokenCount: null,
				highestSuccessTokenCount: null,
				totalAttempts: 0,
				successfulAttempts: 0,
				failedAttempts: 0,
				lastUpdated: now,
			};
			AgentRuntime.dynamicPromptMetrics.set(key, metric);
		}
		return metric;
	}

	private setStructuredOutputFailureState(
		state: State,
		failure: StructuredOutputFailure,
	): void {
		const issues = Array.isArray(failure.issues)
			? failure.issues.filter(
					(issue): issue is string =>
						typeof issue === "string" && issue.trim().length > 0,
				)
			: [];
		const summaryParts = [
			`Structured output ${failure.kind.replaceAll("_", " ")}`,
			`model=${failure.model}`,
			`format=${failure.format}`,
			`attempt=${failure.attempts}/${failure.maxRetries + 1}`,
			...(issues.length > 0 ? [`issue=${issues[0]}`] : []),
			...(failure.parseError ? [`error=${failure.parseError}`] : []),
		];

		state.values = {
			...state.values,
			structuredOutputFailureSummary: summaryParts.join("; "),
		};
		state.data = {
			...state.data,
			structuredOutputFailure: failure,
		};
	}

	private clearStructuredOutputFailureState(state: State): void {
		if (state.values.structuredOutputFailureSummary !== undefined) {
			const { structuredOutputFailureSummary: _discard, ...restValues } =
				state.values;
			state.values = restValues;
		}

		if (state.data.structuredOutputFailure !== undefined) {
			const { structuredOutputFailure: _discard, ...restData } = state.data;
			state.data = restData;
		}
	}

	/**
	 * Dynamic prompt execution with state injection, schema-based parsing, and validation-aware streaming.
	 *
	 * WHY THIS EXISTS:
	 * LLMs are powerful but unreliable for structured outputs. They can:
	 * - Silently truncate output when hitting token limits
	 * - Skip fields or produce malformed structures
	 * - Hallucinate or ignore parts of the prompt
	 *
	 * This method addresses these issues by:
	 * 1. Validation codes: Injects UUID codes the LLM must echo back
	 * 2. Streaming with safety: Enables streaming while detecting truncation
	 * 3. Performance tracking: Tracks success/failure rates per model+schema
	 */
	async dynamicPromptExecFromState({
		state: stateArg,
		params,
		schema,
		options = {},
	}: {
		state?: State;
		params: Omit<GenerateTextParams, "prompt"> & {
			prompt: string | ((ctx: { state: State }) => string);
		};
		schema: SchemaRow[];
		options?: {
			key?: string;
			promptName?: string;
			modelSize?: "nano" | "small" | "medium" | "large" | "mega";
			modelType?: import("./types").TextGenerationModelType;
			model?: string;
			requiredFields?: string[];
			contextCheckLevel?: 0 | 1 | 2 | 3;
			checkpointCodes?: boolean;
			maxRetries?: number;
			retryBackoff?: number | RetryBackoffConfig;
			disableCache?: boolean;
			cacheTTL?: number;
			onStreamChunk?: StreamChunkCallback;
			onStreamEvent?: (
				event: StreamEvent,
				messageId?: string,
			) => void | Promise<void>;
			abortSignal?: AbortSignal;
		};
	}): Promise<Record<string, unknown> | null> {
		const state: State =
			stateArg ?? ({ values: {}, data: {}, text: "" } as State);

		// Validate schema input
		if (!schema || schema.length === 0) {
			this.logger.error(
				"dynamicPromptExecFromState: schema must have at least one entry",
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		const flattenedSchema = this.flattenSchemaRows(schema);
		const schemaWarnings = this.collectSchemaDefinitionWarnings(schema);
		for (const warning of schemaWarnings) {
			this.logger.warn(`dynamicPromptExecFromState schema warning: ${warning}`);
		}

		// Validate field names are valid identifiers
		const invalidFields = flattenedSchema.filter((row) => {
			if (!row.field || typeof row.field !== "string") return true;
			// Field names should be valid identifiers: start with letter/underscore, contain only alphanumeric/underscore
			return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.field);
		});

		if (invalidFields.length > 0) {
			this.logger.error(
				`dynamicPromptExecFromState: invalid field names in schema: ${invalidFields.map((f) => f.field || "(empty)").join(", ")}`,
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		// Generate keys for metrics
		const resolvedModelType = resolveDynamicPromptModelType(
			options.modelType,
			options.modelSize,
		);
		const modelIdentifier =
			options.modelType || options.model || resolvedModelType;
		const schemaKey = this.buildSchemaMetricKey(schema);
		const modelSchemaKey = `${modelIdentifier}:${schemaKey}`;

		// Get validation level from settings or options
		const validationLevelRaw = this.getSetting("VALIDATION_LEVEL");
		const validationLevel =
			typeof validationLevelRaw === "string"
				? validationLevelRaw.toLowerCase()
				: undefined;

		// Map VALIDATION_LEVEL to contextCheckLevel and default retries
		let defaultContextCheckLevel: 0 | 1 | 2 | 3 = 2;
		let defaultRetries = 1;

		if (validationLevel === "trusted" || validationLevel === "fast") {
			defaultContextCheckLevel = 0;
			defaultRetries = 0;
		} else if (validationLevel === "progressive") {
			defaultContextCheckLevel = 1;
			defaultRetries = 2;
		} else if (validationLevel === "strict" || validationLevel === "safe") {
			defaultContextCheckLevel = 3;
			defaultRetries = 3;
		} else if (validationLevel !== undefined) {
			// Warn about unrecognized validation level
			this.logger.warn(
				`Unrecognized VALIDATION_LEVEL "${validationLevel}". ` +
					`Valid values: trusted, fast, progressive, strict, safe. ` +
					`Falling back to default (level 2).`,
			);
		}

		const maxRetries = options.maxRetries ?? defaultRetries;
		const checkpointCodesEnabled =
			options.checkpointCodes ??
			parseBooleanValue(this.getSetting("PROMPT_CHECKPOINT_CODES")) ??
			false;
		let currentRetry = 0;
		const promptCode = () => uuidv4().replaceAll("-", "").slice(0, 8);
		let lastStructuredFailure: StructuredOutputFailure | null = null;

		// Initialize metrics with LRU eviction
		const metric = AgentRuntime.getOrCreateMetrics(modelSchemaKey);

		// Extractor is created once and persists across retries
		let extractor: DynamicPromptStreamExtractor | undefined;
		let contextLevel: 0 | 1 | 2 | 3 = defaultContextCheckLevel;
		const perFieldCodes = new Map<string, string>();

		let traceModelId: string | undefined;
		let tracePromptKey: string | undefined;
		let traceVariant = "baseline";
		let traceArtifactVersion: number | undefined;
		const traceStartTime = Date.now();
		const optimizationHooks = this.getPromptOptimizationHooks();

		if (optimizationHooks) {
			traceModelId = this.resolveProviderModelString(
				resolvedModelType,
				options.model,
			);
			const schemaHash = this.buildSchemaMetricKey(schema)
				.split("")
				.reduce((h, c) => ((h * 31) ^ c.charCodeAt(0)) >>> 0, 5381)
				.toString(16)
				.slice(0, 8);
			tracePromptKey = options.promptName ?? schemaHash;
		}

		while (currentRetry <= maxRetries) {
			const template = params.prompt;
			const templateStr =
				typeof template === "function" ? template({ state }) : template;

			let finalTemplateStr = templateStr;
			if (
				optimizationHooks &&
				traceModelId &&
				tracePromptKey &&
				currentRetry === 0
			) {
				try {
					const merged = await optimizationHooks.mergePromptTemplate(this, {
						baselineTemplate: templateStr,
						modelId: traceModelId,
						modelSlot: resolvedModelType,
						promptKey: tracePromptKey,
					});
					finalTemplateStr = merged.template;
					traceVariant = merged.variant;
					traceArtifactVersion = merged.artifactVersion;
				} catch (optErr) {
					this.logger.warn(
						{ error: optErr },
						"Optimization artifact lookup failed",
					);
				}
			}

			// Get keys from state (excluding text, values, data)
			const stateKeys = Object.keys(state);
			const filteredKeys = stateKeys.filter(
				(key) => !["text", "values", "data"].includes(key),
			);
			const filteredState = filteredKeys.reduce(
				(acc: Record<string, unknown>, key) => {
					acc[key] = state[key];
					return acc;
				},
				{},
			);
			const templateContext = { ...filteredState, ...state.values };

			const outputSegments = this.renderPromptTemplateSegments(
				finalTemplateStr,
				templateContext,
				state,
			);
			const output = outputSegments.map((segment) => segment.content).join("");

			// Process format options
			const format: StructuredResponseFormat = resolveDefaultOutputFormat(
				this.getSetting("PROMPT_OUTPUT_FORMAT"),
			);

			/**
			 * Rough token count estimate for logging/debugging purposes only.
			 *
			 * NOTE: This is a heuristic approximation, not an accurate tokenizer.
			 * Modern LLMs use subword tokenization (BPE, WordPiece, SentencePiece)
			 * where actual token counts vary significantly by model and content.
			 *
			 * The 1.3x multiplier accounts for:
			 * - Subword splitting of longer/uncommon words
			 * - Punctuation and special characters as separate tokens
			 * - Whitespace handling differences
			 *
			 * For accurate counts, use model-specific tokenizers (e.g., tiktoken).
			 * This estimate is sufficient for logging and rough capacity planning.
			 */
			const estToken = (text: string) => {
				const words = text
					.trim()
					.split(/\s+|\b/)
					.filter((w) => /\w+/.test(w));
				return Math.ceil(words.length * 1.3);
			};

			// estToken scans the full multi-KB output; only run it when the debug
			// log it feeds would actually be emitted.
			if (RUNTIME_DEBUG_LOG_ENABLED) {
				this.logger.debug(
					`dynamicPromptExecFromState: using format ${format}, ~${estToken(output).toLocaleString()} tokens`,
				);
			}

			// Set context level on first iteration
			if (currentRetry === 0) {
				contextLevel = options.contextCheckLevel ?? defaultContextCheckLevel;

				// Generate per-field validation codes for levels 0-1
				if (contextLevel <= 1) {
					for (const row of schema) {
						const defaultValidate = contextLevel === 1;
						const needsValidation = row.validateField ?? defaultValidate;
						if (needsValidation) {
							perFieldCodes.set(row.field, promptCode());
						}
					}
				}

				const streamFields = resolveDynamicPromptStreamFields(schema);
				if (
					streamFields.length > 0 &&
					(options.onStreamChunk || options.onStreamEvent)
				) {
					extractor = new StructuredFieldStreamExtractor({
						level: contextLevel,
						schema,
						streamFields,
						...(options.abortSignal
							? { abortSignal: options.abortSignal }
							: {}),
						onChunk: (chunk, _field, accumulated) => {
							void options.onStreamChunk?.(chunk, undefined, accumulated);
						},
						onEvent: (event) => {
							void options.onStreamEvent?.(event, undefined);
						},
					});
				}
			}

			// Optional checkpoint codes: level 2+ gets first codes, level 3 gets both.
			const first = checkpointCodesEnabled && contextLevel >= 2;
			const last = checkpointCodesEnabled && contextLevel >= 3;

			// Build extended schema with validation codes
			const extSchema: Array<{
				field: string;
				description: string;
				required?: boolean;
			}> = [];

			const codesSchema = (prefix: string) => [
				{
					field: `${prefix}initial_code`,
					description: "echo the initial prompt code",
				},
				{
					field: `${prefix}middle_code`,
					description: "echo the middle prompt code",
				},
				{
					field: `${prefix}end_code`,
					description: "echo the end prompt code",
				},
			];

			if (first) {
				extSchema.push(...codesSchema("one_"));
			}

			// Add schema fields with per-field codes for levels 0-1
			for (const row of schema) {
				const fieldCode = perFieldCodes.get(row.field);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_start`,
						description: `output exactly: ${fieldCode}`,
					});
				}
				extSchema.push(row);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_end`,
						description: `output exactly: ${fieldCode}`,
					});
				}
			}

			if (last) {
				extSchema.push(...codesSchema("two_"));
			}

			// Generate prompt with format example
			const EXAMPLE = this.renderJsonSchemaExample(schema);
			const VALIDATION_INSTRUCTIONS = this.buildValidationOutputInstructions({
				format,
				schema,
				perFieldCodes,
				includeFirstCheckpoint: first,
				includeLastCheckpoint: last,
			});

			const initCode = checkpointCodesEnabled ? promptCode() : "";
			const midCode = checkpointCodesEnabled ? promptCode() : "";
			const finalCode = checkpointCodesEnabled ? promptCode() : "";

			// Check for smart retry context (set by previous retry iteration)
			const smartRetryContextRaw = (state as Record<string, unknown>)
				._smartRetryContext;
			const smartRetryContext =
				typeof smartRetryContextRaw === "string"
					? smartRetryContextRaw.trim()
					: "";

			const section_start = "# Strict Output instructions";
			const section_end = "";

			const variableSegments = this.joinPromptSegmentGroups([
				checkpointCodesEnabled
					? [{ content: `initial code: ${initCode}`, stable: false }]
					: [],
				outputSegments,
				smartRetryContext
					? [{ content: smartRetryContext, stable: false }]
					: [],
				checkpointCodesEnabled
					? [{ content: `middle code: ${midCode}`, stable: false }]
					: [],
			]).concat({ content: "\n", stable: false });
			// Prompt cache hints: build segments so providers can cache the stable prefix.
			// WHY: We only mark content stable when it is identical across calls for the same
			// schema/character. VALIDATION_INSTRUCTIONS contains per-call UUIDs (perFieldCodes,
			// checkpoint codes), so it must be in an unstable segment; otherwise provider caches
			// would never hit. Format instructions and example (same for same schema) are stable.
			const formatStablePrefix =
				section_start +
				`\nReturn only ${format}. No prose before or after it. No <think>.

`;
			const formatStableSuffix = `
Use this shape:
${EXAMPLE}

Return exactly one JSON object.
${section_end}`;
			const endBlock = checkpointCodesEnabled
				? `\nend code: ${finalCode}\n`
				: "\n";
			// Middle block: validation text when present (unstable); else "\n\n" so prompt string is unchanged.
			const formatMiddleBlock = VALIDATION_INSTRUCTIONS
				? `${VALIDATION_INSTRUCTIONS}\n\n`
				: "\n\n";

			const segments: PromptSegment[] = this.mergePromptSegments([
				...variableSegments,
				{ content: formatStablePrefix, stable: true },
				{ content: formatMiddleBlock, stable: false },
				{ content: formatStableSuffix, stable: true },
				{ content: endBlock, stable: false },
			]);
			const prompt = segments.map((s) => s.content).join("");

			// Token estimate used for:
			// 1. Debug logging of prompt size
			// 2. Metrics tracking: highestSuccessTokenCount / lowestFailedTokenCount
			//    (useful for identifying token-count-related failure patterns)
			const outputTokenEst = estToken(prompt);
			this.logger.debug(
				`dynamicPromptExecFromState prompt ~${outputTokenEst.toLocaleString()} tokens`,
			);

			// Pass promptSegments so providers can use cache hints when supported (Anthropic block cache, OpenAI/Gemini prefix).
			const modelParams = {
				...params,
				prompt,
				responseFormat: params.responseFormat ?? { type: "json_object" },
				promptSegments: segments,
				providerOptions: {
					agentName: this.character.name,
				},
				...(extractor
					? {
							onStreamChunk: (chunk: string) => {
								extractor?.push(chunk);
							},
						}
					: {}),
			};

			// Check for cancellation before request
			if (options.abortSignal?.aborted) {
				extractor?.signalError("Cancelled by user");
				delete (state as Record<string, unknown>)._smartRetryContext;
				this.clearStructuredOutputFailureState(state);
				return null;
			}

			let response: string;
			try {
				response = await runWithStreamingContext(undefined, () =>
					this.useModel(resolvedModelType, modelParams, options.model),
				);
			} catch (modelError) {
				const modelErrorMessage = getErrorMessage(modelError);
				const isTransientFailure = isTransientModelError(modelError);
				const willRetry = currentRetry + 1 <= maxRetries;
				const failureMessage = isTransientFailure
					? `Model call failed transiently${willRetry ? ", retrying" : ""}: ${modelErrorMessage}`
					: `Model call failed: ${modelErrorMessage}`;
				if (isTransientFailure) {
					this.logger.warn(failureMessage);
				} else {
					this.logger.error(failureMessage);
				}
				lastStructuredFailure = {
					source: "dynamicPromptExecFromState",
					kind: "model_error",
					model: String(modelIdentifier),
					format,
					schemaFields: flattenedSchema.map((row) => row.field),
					attempts: currentRetry + 1,
					maxRetries,
					timestamp: Date.now(),
					key: options.key ?? modelSchemaKey,
					parseError: modelErrorMessage,
					issues: [
						"Model call failed before a structured response could be validated.",
					],
				};
				currentRetry++;

				if (options.abortSignal?.aborted) {
					extractor?.signalError("Cancelled by user");
					delete (state as Record<string, unknown>)._smartRetryContext;
					this.clearStructuredOutputFailureState(state);
					return null;
				}

				if (currentRetry <= maxRetries) {
					// Apply retry backoff for model errors
					if (options.retryBackoff) {
						const delayMs = this.calculateBackoffDelay(
							options.retryBackoff,
							currentRetry,
						);
						this.logger.debug(
							`Retry backoff: waiting ${delayMs}ms before retry ${currentRetry}`,
						);

						// Abortable sleep - check signal during wait, not just after
						const aborted = await this.abortableSleep(
							delayMs,
							options.abortSignal,
						);
						if (aborted) {
							extractor?.signalError("Cancelled by user");
							delete (state as Record<string, unknown>)._smartRetryContext;
							this.clearStructuredOutputFailureState(state);
							return null;
						}
					}

					// Signal retry to extractor if it exists
					if (extractor) {
						extractor.signalRetry(currentRetry);
						extractor.reset();
					}
				}
				continue;
			}

			// Clean response (remove <think> blocks)
			const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, "");

			let responseContent: Record<string, unknown> | null = null;
			let parseErrorMessage: string | undefined;
			const validationIssues: string[] = [];
			try {
				responseContent = this.parseStructuredResponse(cleanResponse, format);
				this.logger.debug(
					`dynamicPromptExecFromState parsed: ${JSON.stringify(responseContent)}`,
				);
			} catch (e) {
				parseErrorMessage = e instanceof Error ? e.message : String(e);
				this.logger.error(
					`dynamicPromptExecFromState parse error: ${parseErrorMessage}`,
				);
			}

			responseContent = this.normalizeStructuredResponse(responseContent);

			// Validate response
			let allGood = true;
			let schemaValidation: { missingPaths: string[]; invalidPaths: string[] } =
				{
					missingPaths: [],
					invalidPaths: [],
				};
			if (!responseContent) {
				validationIssues.push(
					"No structured output could be parsed from the model response.",
				);
				this.logger.warn(
					`dynamicPromptExecFromState parse problem: ${cleanResponse}`,
				);
				allGood = false;
			} else {
				// Validate codes based on context level
				if (contextLevel <= 1) {
					// Per-field validation
					for (const [field, expectedCode] of perFieldCodes) {
						const startCodeField = `code_${field}_start`;
						const endCodeField = `code_${field}_end`;
						const startCode = responseContent[startCodeField];
						const endCode = responseContent[endCodeField];

						if (startCode !== expectedCode || endCode !== expectedCode) {
							validationIssues.push(
								`Per-field validation failed for ${field}.`,
							);
							this.logger.warn(
								`Per-field validation failed for ${field}: expected=${expectedCode}, start=${startCode}, end=${endCode}`,
							);
							allGood = false;
						}

						delete responseContent[startCodeField];
						delete responseContent[endCodeField];
					}
				} else {
					// Checkpoint validation
					const validationCodes: [string, string][] = [
						...(first
							? [
									["one_initial_code", initCode] as [string, string],
									["one_middle_code", midCode] as [string, string],
									["one_end_code", finalCode] as [string, string],
								]
							: []),
						...(last
							? [
									["two_initial_code", initCode] as [string, string],
									["two_middle_code", midCode] as [string, string],
									["two_end_code", finalCode] as [string, string],
								]
							: []),
					];

					for (const [field, expected] of validationCodes) {
						if (responseContent[field] !== expected) {
							validationIssues.push(
								`Checkpoint validation failed for ${field}.`,
							);
							this.logger.warn(
								`Checkpoint ${field} mismatch: expected ${expected}`,
							);
							allGood = false;
						}
					}

					if (first) {
						delete responseContent.one_initial_code;
						delete responseContent.one_middle_code;
						delete responseContent.one_end_code;
					}
					if (last) {
						delete responseContent.two_initial_code;
						delete responseContent.two_middle_code;
						delete responseContent.two_end_code;
					}
				}

				schemaValidation = this.validateResponseAgainstSchema(
					responseContent,
					schema,
				);
				if (
					schemaValidation.missingPaths.length > 0 ||
					schemaValidation.invalidPaths.length > 0
				) {
					if (schemaValidation.missingPaths.length > 0) {
						validationIssues.push(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
						this.logger.warn(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
					}
					if (schemaValidation.invalidPaths.length > 0) {
						validationIssues.push(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
						this.logger.warn(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
					}
					allGood = false;
				}

				// Validate required fields
				if (options.requiredFields && options.requiredFields.length > 0) {
					const isMissingField = (value: unknown): boolean => {
						if (value === undefined || value === null) return true;
						if (typeof value === "string") return value.trim().length === 0;
						if (Array.isArray(value)) return value.length === 0;
						if (typeof value === "object")
							return Object.keys(value).length === 0;
						return false;
					};

					const missingFields = options.requiredFields.filter(
						(field) =>
							!responseContent ||
							!(field in responseContent) ||
							isMissingField(responseContent[field]),
					);
					if (missingFields.length > 0) {
						validationIssues.push(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						this.logger.warn(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						allGood = false;
					}
				}
			}

			// Update metrics
			metric.totalAttempts++;

			if (allGood && responseContent) {
				// Success - flush buffered content for levels 2-3
				if (extractor) {
					extractor.flush();
				}

				metric.successfulAttempts++;
				if (
					metric.highestSuccessTokenCount === null ||
					outputTokenEst > metric.highestSuccessTokenCount
				) {
					metric.highestSuccessTokenCount = outputTokenEst;
				}
				metric.lastUpdated = Date.now();

				this.logger.debug(
					`dynamicPromptExecFromState success [${modelSchemaKey}]: ${outputTokenEst} tokens`,
				);

				// Clean up smart retry context from state
				delete (state as Record<string, unknown>)._smartRetryContext;

				if (optimizationHooks && traceModelId && tracePromptKey) {
					try {
						const scoreCard = new ScoreCard();
						scoreCard.add({
							source: "dpe",
							kind: "parseSuccess",
							value: 1.0,
							reason: "Structured output parsed successfully",
						});
						const schemaOk =
							schemaValidation.missingPaths.length === 0 &&
							schemaValidation.invalidPaths.length === 0;
						scoreCard.add({
							source: "dpe",
							kind: "schemaValid",
							value: schemaOk ? 1.0 : 0.0,
							reason: schemaOk
								? "Response matched schema paths"
								: `Schema issues: missing [${schemaValidation.missingPaths.join(", ")}]; invalid [${schemaValidation.invalidPaths.join(", ")}]`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "retriesUsed",
							value: Math.max(0, 1.0 - currentRetry / Math.max(maxRetries, 1)),
							reason: `Succeeded on attempt ${currentRetry + 1} of ${maxRetries + 1}`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "tokenEfficiency",
							value: Math.min(1.0, 500 / Math.max(outputTokenEst, 1)),
							reason: `Estimated output tokens ${outputTokenEst} vs reference 500`,
						});

						const templateHashInput =
							typeof params.prompt === "string"
								? params.prompt
								: tracePromptKey;
						const computedTemplateHash = simpleHash(templateHashInput);

						const trace: ExecutionTrace = {
							id: uuidv4(),
							traceVersion: 1,
							type: "trace",
							promptKey: tracePromptKey,
							modelSlot: resolvedModelType,
							modelId: traceModelId,
							runId: this.getCurrentRunId(),
							templateHash: computedTemplateHash,
							schemaFingerprint: schemaKey,
							artifactVersion: traceArtifactVersion,
							variant: traceVariant,
							parseSuccess: true,
							schemaValid:
								schemaValidation.missingPaths.length === 0 &&
								schemaValidation.invalidPaths.length === 0,
							validationCodesMatched: true,
							retriesUsed: currentRetry,
							tokenEstimate: outputTokenEst,
							latencyMs: Date.now() - traceStartTime,
							response: responseContent,
							scoreCard: scoreCard.toJSON(),
							createdAt: Date.now(),
						};

						this.maybeRunActiveTraceTTLPurge();
						const runId = trace.runId;
						if (runId) {
							this.activeTraces.set(trace.id, trace);
							if (!this.runToTraces.has(runId)) {
								this.runToTraces.set(runId, new Set());
							}
							this.runToTraces.get(runId)?.add(trace.id);
						}

						void optimizationHooks
							.persistRegistryEntry(this, {
								promptKey: tracePromptKey,
								schemaFingerprint: schemaKey,
								templateHash: computedTemplateHash,
								promptTemplate:
									typeof params.prompt === "string" ? params.prompt : "",
								schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
							})
							.catch((err) => {
								this.logger.warn(
									{ error: err, src: "dpe" },
									"Failed to write prompt optimization registry",
								);
							});
						void optimizationHooks
							.appendBaselineTrace(this, { trace })
							.catch((err) => {
								this.logger.warn("Failed to write optimization trace", err);
							});
					} catch (traceErr) {
						this.logger.warn(
							{ error: traceErr },
							"Failed to build optimization trace",
						);
					}
				}

				this.clearStructuredOutputFailureState(state);
				return responseContent;
			}

			lastStructuredFailure = {
				source: "dynamicPromptExecFromState",
				kind: !responseContent
					? parseErrorMessage
						? "parse_error"
						: "parse_problem"
					: "validation_error",
				model: String(modelIdentifier),
				format,
				schemaFields: flattenedSchema.map((row) => row.field),
				attempts: currentRetry + 1,
				maxRetries,
				timestamp: Date.now(),
				key: options.key ?? modelSchemaKey,
				parseError: parseErrorMessage,
				issues: validationIssues,
				responsePreview: this.redactSecrets(cleanResponse).slice(
					0,
					AgentRuntime.STRUCTURED_FAILURE_PREVIEW_LIMIT,
				),
			};

			// Failure - update metrics
			metric.failedAttempts++;
			if (
				metric.lowestFailedTokenCount === null ||
				outputTokenEst < metric.lowestFailedTokenCount
			) {
				metric.lowestFailedTokenCount = outputTokenEst;
			}

			currentRetry++;

			if (options.abortSignal?.aborted) {
				extractor?.signalError("Cancelled by user");
				delete (state as Record<string, unknown>)._smartRetryContext;
				this.clearStructuredOutputFailureState(state);
				return null;
			}

			if (currentRetry <= maxRetries) {
				// Apply retry backoff
				if (options.retryBackoff) {
					const delayMs = this.calculateBackoffDelay(
						options.retryBackoff,
						currentRetry,
					);
					this.logger.debug(
						`Retry backoff: waiting ${delayMs}ms before retry ${currentRetry}`,
					);

					// Abortable sleep - check signal during wait, not just after
					const aborted = await this.abortableSleep(
						delayMs,
						options.abortSignal,
					);
					if (aborted) {
						extractor?.signalError("Cancelled by user");
						delete (state as Record<string, unknown>)._smartRetryContext;
						this.clearStructuredOutputFailureState(state);
						return null;
					}
				}

				// Signal retry to extractor
				let smartRetryContextNext: string | undefined;
				if (extractor) {
					const { validatedFields } = extractor.signalRetry(currentRetry);
					const diagnosis = extractor.diagnose();

					this.logger.warn(
						`dynamicPromptExecFromState retry ${currentRetry}/${maxRetries}`,
						`validated=${validatedFields.join(",") || "none"}`,
						`missing=${diagnosis.missingFields.join(",") || "none"}`,
					);

					// For level 1, build smart retry context
					if (contextLevel === 1 && validatedFields.length > 0) {
						const validatedContent = extractor.getValidatedFields();
						const validatedParts: string[] = [];
						for (const [field, content] of validatedContent) {
							const truncated =
								content.length > 500 ? `${content.slice(0, 500)}...` : content;
							validatedParts.push(
								stringifyStructuredForPrompt({ [field]: truncated }),
							);
						}
						if (validatedParts.length > 0) {
							smartRetryContextNext = `\n\n[RETRY CONTEXT]\nYou previously produced these valid fields:\n${validatedParts.join("\n")}\n\nPlease complete: ${diagnosis.missingFields.concat(diagnosis.invalidFields, diagnosis.incompleteFields).join(", ") || "all fields"}`;
						}
					}

					extractor.reset();
				}

				// Repair reroll: when the extractor didn't produce a targeted retry
				// context (the common case — contextLevel 2, no streaming extractor,
				// or no validated fields), feed the model the CONCRETE reason its last
				// output was rejected + the (redacted, truncated) bad output, so the
				// reroll is corrective instead of a blind re-roll of the same prompt.
				// Goes in the same `_smartRetryContext` field, which is rendered as a
				// `stable:false` segment (prompt-cache safe) and cleared on
				// success/abort. Correctness-neutral: it only changes the prompt of a
				// retry that was already going to run; it never skips a validation.
				if (!smartRetryContextNext) {
					const repairIssues =
						validationIssues.length > 0
							? validationIssues
							: parseErrorMessage
								? [parseErrorMessage]
								: [];
					if (repairIssues.length > 0) {
						const priorOutput = this.redactSecrets(cleanResponse).slice(
							0,
							AgentRuntime.STRUCTURED_FAILURE_PREVIEW_LIMIT,
						);
						const issueList = repairIssues
							.slice(0, 8)
							.map((issue) => `- ${issue}`)
							.join("\n");
						smartRetryContextNext = `\n\n[REPAIR] Your previous response was rejected because it did not satisfy the required schema. Fix exactly these problems and return a corrected response:\n${issueList}${
							priorOutput
								? `\n\nYour previous (invalid) output was:\n${priorOutput}`
								: ""
						}`;
					}
				}

				if (smartRetryContextNext) {
					(state as Record<string, unknown>)._smartRetryContext =
						smartRetryContextNext;
				}
			}
		}

		// Max retries exceeded
		if (extractor) {
			const diagnosis = extractor.diagnose();
			const diagnosticParts: string[] = [];
			if (diagnosis.missingFields.length > 0) {
				diagnosticParts.push(`missing: ${diagnosis.missingFields.join(", ")}`);
			}
			if (diagnosis.invalidFields.length > 0) {
				diagnosticParts.push(`invalid: ${diagnosis.invalidFields.join(", ")}`);
			}
			if (diagnosis.incompleteFields.length > 0) {
				diagnosticParts.push(
					`partial: ${diagnosis.incompleteFields.join(", ")}`,
				);
			}
			extractor.signalError(
				`Failed after ${maxRetries} retries. ${diagnosticParts.length > 0 ? diagnosticParts.join("; ") : "unknown error"}`,
			);
		}

		const finalFailureMessage = `dynamicPromptExecFromState failed after ${maxRetries} retries [${modelSchemaKey}]`;
		const finalFailureSummary = `${metric.successfulAttempts}/${metric.totalAttempts} successful`;
		if (
			lastStructuredFailure?.kind === "model_error" &&
			isTransientModelError(lastStructuredFailure.parseError)
		) {
			this.logger.warn(finalFailureMessage, finalFailureSummary);
		} else {
			this.logger.error(finalFailureMessage, finalFailureSummary);
		}

		if (optimizationHooks && traceModelId && tracePromptKey) {
			try {
				this.purgeStaleActiveTraces();

				const scoreCard = new ScoreCard();
				scoreCard.add({
					source: "dpe",
					kind: "parseSuccess",
					value: 0.0,
					reason: `No valid parse after ${maxRetries} retries`,
				});
				scoreCard.add({
					source: "dpe",
					kind: "schemaValid",
					value: 0.0,
					reason: "Parse or validation never succeeded",
				});
				scoreCard.add({
					source: "dpe",
					kind: "retriesUsed",
					value: 0.0,
					reason: "All retry attempts exhausted",
				});

				const failTemplateHash = simpleHash(
					typeof params.prompt === "string" ? params.prompt : tracePromptKey,
				);

				const trace: ExecutionTrace = {
					id: uuidv4(),
					traceVersion: 1,
					type: "trace",
					promptKey: tracePromptKey,
					modelSlot: resolvedModelType,
					modelId: traceModelId,
					runId: this.getCurrentRunId(),
					templateHash: failTemplateHash,
					schemaFingerprint: schemaKey,
					artifactVersion: traceArtifactVersion,
					variant: traceVariant,
					parseSuccess: false,
					schemaValid: false,
					validationCodesMatched: false,
					retriesUsed: maxRetries,
					tokenEstimate: 0,
					latencyMs: Date.now() - traceStartTime,
					scoreCard: scoreCard.toJSON(),
					createdAt: Date.now(),
				};

				void optimizationHooks
					.persistRegistryEntry(this, {
						promptKey: tracePromptKey,
						schemaFingerprint: schemaKey,
						templateHash: failTemplateHash,
						promptTemplate:
							typeof params.prompt === "string" ? params.prompt : "",
						schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
					})
					.catch((err) => {
						this.logger.warn(
							{ error: err, src: "dpe" },
							"Failed to write prompt optimization registry",
						);
					});
				void optimizationHooks
					.appendFailureTrace(this, { trace })
					.catch((err) => {
						this.logger.warn("Failed to write failure trace", err);
					});
			} catch (traceErr) {
				this.logger.warn({ error: traceErr }, "Failed to build failure trace");
			}
		}

		// Clean up smart retry context from state
		delete (state as Record<string, unknown>)._smartRetryContext;
		if (lastStructuredFailure) {
			this.setStructuredOutputFailureState(state, lastStructuredFailure);
		} else {
			this.clearStructuredOutputFailureState(state);
		}
		return null;
	}

	private flattenSchemaRows(rows: SchemaRow[]): SchemaRow[] {
		const flattened: SchemaRow[] = [];
		for (const row of rows) {
			flattened.push(row);
			if (row.properties?.length) {
				flattened.push(...this.flattenSchemaRows(row.properties));
			}
			if (row.items?.properties?.length) {
				flattened.push(...this.flattenSchemaRows(row.items.properties));
			}
		}
		return flattened;
	}

	private renderJsonSchemaExample(rows: SchemaRow[]): string {
		const exampleObject = Object.fromEntries(
			rows.map((row) => [row.field, this.buildJsonExampleValue(row)]),
		);
		return `${JSON.stringify(exampleObject, null, 2)}\n`;
	}

	private buildJsonExampleValue(spec: SchemaValueSpec): unknown {
		return this.buildJsonExampleValueAtDepth(spec, 0);
	}

	private buildJsonExampleValueAtDepth(
		spec: SchemaValueSpec,
		depth: number,
	): unknown {
		if (depth > 8) {
			return "[max schema depth reached]";
		}

		switch (this.getEffectiveSchemaValueType(spec)) {
			case "number":
				return 123;
			case "boolean":
				return true;
			case "object":
				if (spec.properties?.length) {
					return Object.fromEntries(
						spec.properties.map((row) => [
							row.field,
							this.buildJsonExampleValueAtDepth(row, depth + 1),
						]),
					);
				}
				return {};
			case "array":
				return [
					this.buildJsonExampleValueAtDepth(
						spec.items ?? { description: spec.description },
						depth + 1,
					),
				];
			default:
				return spec.description;
		}
	}

	private validateResponseAgainstSchema(
		responseContent: Record<string, unknown>,
		schema: SchemaRow[],
	): { missingPaths: string[]; invalidPaths: string[] } {
		const missingPaths: string[] = [];
		const invalidPaths: string[] = [];
		for (const row of schema) {
			this.validateSchemaValue(
				responseContent[row.field],
				row,
				row.field,
				missingPaths,
				invalidPaths,
			);
		}
		return { missingPaths, invalidPaths };
	}

	private validateSchemaValue(
		value: unknown,
		spec: SchemaValueSpec,
		path: string,
		missingPaths: string[],
		invalidPaths: string[],
	): void {
		this.validateSchemaValueAtDepth(
			value,
			spec,
			path,
			missingPaths,
			invalidPaths,
			0,
		);
	}

	private validateSchemaValueAtDepth(
		value: unknown,
		spec: SchemaValueSpec,
		path: string,
		missingPaths: string[],
		invalidPaths: string[],
		depth: number,
	): void {
		if (depth > 8) {
			invalidPaths.push(path);
			return;
		}

		const isMissingValue = (inner: unknown): boolean => {
			if (inner === undefined || inner === null) return true;
			if (typeof inner === "string") return inner.trim().length === 0;
			if (Array.isArray(inner)) return inner.length === 0;
			if (typeof inner === "object") return Object.keys(inner).length === 0;
			return false;
		};

		if (isMissingValue(value)) {
			if (spec.required) {
				missingPaths.push(path);
			}
			return;
		}

		switch (this.getEffectiveSchemaValueType(spec)) {
			case "number":
				if (
					typeof value !== "number" &&
					!(
						typeof value === "string" &&
						value.trim() !== "" &&
						!Number.isNaN(Number(value))
					)
				) {
					invalidPaths.push(path);
				}
				return;
			case "boolean":
				if (
					typeof value !== "boolean" &&
					!(
						typeof value === "string" &&
						["true", "false"].includes(value.trim().toLowerCase())
					)
				) {
					invalidPaths.push(path);
				}
				return;
			case "object":
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value)
				) {
					invalidPaths.push(path);
					return;
				}
				for (const property of spec.properties ?? []) {
					this.validateSchemaValueAtDepth(
						(value as Record<string, unknown>)[property.field],
						property,
						`${path}.${property.field}`,
						missingPaths,
						invalidPaths,
						depth + 1,
					);
				}
				return;
			case "array":
				if (!Array.isArray(value)) {
					invalidPaths.push(path);
					return;
				}
				if (spec.items) {
					value.forEach((item, index) => {
						this.validateSchemaValueAtDepth(
							item,
							spec.items as SchemaValueSpec,
							`${path}[${index}]`,
							missingPaths,
							invalidPaths,
							depth + 1,
						);
					});
				}
				return;
			default:
				return;
		}
	}

	private buildValidationOutputInstructions({
		format: _format,
		schema,
		perFieldCodes,
		includeFirstCheckpoint,
		includeLastCheckpoint,
	}: {
		format: StructuredResponseFormat;
		schema: SchemaRow[];
		perFieldCodes: Map<string, string>;
		includeFirstCheckpoint: boolean;
		includeLastCheckpoint: boolean;
	}): string {
		const lines: string[] = [];

		if (includeFirstCheckpoint) {
			lines.push(
				'Echo the prompt checkpoint fields: "one_initial_code", "one_middle_code", "one_end_code".',
			);
		}

		for (const row of schema) {
			const fieldCode = perFieldCodes.get(row.field);
			if (!fieldCode) {
				continue;
			}

			lines.push(
				`For "${row.field}", include "code_${row.field}_start": "${fieldCode}" and "code_${row.field}_end": "${fieldCode}".`,
			);
		}

		if (includeLastCheckpoint) {
			lines.push(
				'Echo the final checkpoint fields: "two_initial_code", "two_middle_code", "two_end_code".',
			);
		}

		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	}

	private getEffectiveSchemaValueType(
		spec: SchemaValueSpec,
	): NonNullable<SchemaValueSpec["type"]> {
		if (spec.type) {
			return spec.type;
		}
		if (spec.items) {
			return "array";
		}
		if ((spec.properties?.length ?? 0) > 0) {
			return "object";
		}
		return "string";
	}

	private collectSchemaDefinitionWarnings(rows: SchemaRow[]): string[] {
		const warnings: string[] = [];
		for (const row of rows) {
			this.collectSchemaSpecWarnings(row, row.field, warnings);
		}
		return warnings;
	}

	private collectSchemaSpecWarnings(
		spec: SchemaValueSpec,
		path: string,
		warnings: string[],
		depth = 0,
	): void {
		if (depth > 8) {
			warnings.push(`${path} exceeds max supported nesting depth`);
			return;
		}

		const hasProperties = (spec.properties?.length ?? 0) > 0;
		const hasItems = spec.items !== undefined;

		if (hasProperties && hasItems) {
			warnings.push(
				`${path} defines both properties and items; choose one shape`,
			);
		}

		if (spec.type === "array" && hasProperties) {
			warnings.push(`${path} is type "array" but also defines properties`);
		}

		if (spec.type === "object" && hasItems) {
			warnings.push(`${path} is type "object" but also defines items`);
		}

		if (
			(spec.type === "string" ||
				spec.type === "number" ||
				spec.type === "boolean") &&
			(hasProperties || hasItems)
		) {
			warnings.push(
				`${path} is type "${spec.type}" but also defines nested structure`,
			);
		}

		for (const property of spec.properties ?? []) {
			this.collectSchemaSpecWarnings(
				property,
				`${path}.${property.field}`,
				warnings,
				depth + 1,
			);
		}

		if (spec.items) {
			this.collectSchemaSpecWarnings(
				spec.items,
				`${path}[]`,
				warnings,
				depth + 1,
			);
		}
	}

	private buildSchemaMetricKey(rows: SchemaRow[]): string {
		return rows.map((row) => this.serializeSchemaMetricRow(row)).join("|");
	}

	private serializeSchemaMetricRow(row: SchemaRow): string {
		return `${row.field}${row.required ? "!" : ""}:${this.serializeSchemaMetricSpec(row)}`;
	}

	private serializeSchemaMetricSpec(spec: SchemaValueSpec): string {
		return this.serializeSchemaMetricSpecAtDepth(spec, 0);
	}

	private serializeSchemaMetricSpecAtDepth(
		spec: SchemaValueSpec,
		depth: number,
	): string {
		if (depth > 8) {
			return "max-depth";
		}

		const effectiveType = this.getEffectiveSchemaValueType(spec);
		switch (effectiveType) {
			case "object":
				return `object{${(spec.properties ?? [])
					.map(
						(property) =>
							`${property.field}${property.required ? "!" : ""}:${this.serializeSchemaMetricSpecAtDepth(property, depth + 1)}`,
					)
					.join(",")}}`;
			case "array":
				return `array[${spec.items ? this.serializeSchemaMetricSpecAtDepth(spec.items, depth + 1) : "unknown"}]`;
			default:
				return effectiveType;
		}
	}

	/**
	 * Calculate retry backoff delay.
	 */
	private calculateBackoffDelay(
		config: number | RetryBackoffConfig,
		retryCount: number,
	): number {
		if (typeof config === "number") {
			return config;
		}
		const { initialMs = 1000, multiplier = 2, maxMs = 30000 } = config;
		const delay = initialMs * multiplier ** (retryCount - 1);
		return Math.min(delay, maxMs);
	}

	/**
	 * Sleep for a duration that can be interrupted by an abort signal.
	 * Returns true if aborted, false if sleep completed normally.
	 */
	private abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(true);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(false);
			}, ms);

			const onAbort = () => {
				clearTimeout(timeout);
				resolve(true);
			};

			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/**
	 * Template rendering helpers for prompt caching and deterministic compilation.
	 */
	private getCompiledRuntimeTemplate(
		template: string,
		alreadyUpgraded = false,
	): Handlebars.TemplateDelegate<Record<string, unknown>> {
		const source = alreadyUpgraded
			? template
			: this.upgradeDoubleToTriple(template);
		const cached = RUNTIME_TEMPLATE_CACHE.get(source);
		if (cached) {
			return cached;
		}

		const compiled = Handlebars.compile(source);
		RUNTIME_TEMPLATE_CACHE.set(source, compiled);
		if (RUNTIME_TEMPLATE_CACHE.size > RUNTIME_TEMPLATE_CACHE_LIMIT) {
			const oldestKey = RUNTIME_TEMPLATE_CACHE.keys().next().value;
			if (typeof oldestKey === "string") {
				RUNTIME_TEMPLATE_CACHE.delete(oldestKey);
			}
		}

		return compiled;
	}

	private cleanDynamicPromptTemplateOutput(rawOutput: string): string {
		return rawOutput
			.replace(/<output>[\s\S]*?<\/output>\s*/g, "")
			.replace(/\noutput:\n[\s\S]*$/i, "")
			.replace(/\r\n/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	private extractTemplatePlaceholderKeys(templateChunk: string): string[] {
		const keys = new Set<string>();
		const PLACEHOLDER_PATTERN = /\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g;
		let match = PLACEHOLDER_PATTERN.exec(templateChunk);
		while (match) {
			if (match[1]) {
				keys.add(match[1]);
			}
			match = PLACEHOLDER_PATTERN.exec(templateChunk);
		}
		return [...keys];
	}

	private isTemplateChunkStable(templateChunk: string): boolean {
		const placeholderKeys = this.extractTemplatePlaceholderKeys(templateChunk);
		return placeholderKeys.every(
			(key) => key !== "providers" && STABLE_PROMPT_TEMPLATE_KEYS.has(key),
		);
	}

	private getPromptProviderSegments(state: State): PromptSegment[] {
		const providerResults = state.data.providers as
			| Record<string, { text?: string; providerName?: string }>
			| undefined;
		if (!providerResults) {
			return [];
		}

		const providerOrder = Array.isArray(state.data.providerOrder)
			? (state.data.providerOrder as string[])
			: Object.keys(providerResults).sort((left, right) =>
					left.localeCompare(right),
				);

		const segments: PromptSegment[] = [];
		for (const providerName of providerOrder) {
			const result = providerResults[providerName];
			if (!result?.text || result.text.trim() === "") {
				continue;
			}

			if (segments.length > 0) {
				segments.push({ content: "\n", stable: false });
			}

			segments.push({
				content: result.text,
				stable: STABLE_PROMPT_PROVIDER_NAMES.has(providerName),
			});
		}

		return this.mergePromptSegments(segments);
	}

	private renderPromptTemplateSegments(
		templateStr: string,
		context: Record<string, unknown>,
		state: State,
	): PromptSegment[] {
		const upgradedTemplate = this.upgradeDoubleToTriple(templateStr);
		const templateWithMarkers = upgradedTemplate.replace(
			/\{\{\{?\s*providers\s*\}?\}\}/g,
			PROVIDERS_PROMPT_MARKER,
		);
		const templateFunction = this.getCompiledRuntimeTemplate(
			templateWithMarkers,
			true,
		);
		const renderedWithMarkers = this.cleanDynamicPromptTemplateOutput(
			templateFunction(context),
		);

		if (
			!templateWithMarkers.includes(PROVIDERS_PROMPT_MARKER) ||
			!renderedWithMarkers.includes(PROVIDERS_PROMPT_MARKER)
		) {
			return [
				{
					content: renderedWithMarkers,
					stable: this.isTemplateChunkStable(upgradedTemplate),
				},
			];
		}

		const providerSegments = this.getPromptProviderSegments(state);
		if (providerSegments.length === 0) {
			return [
				{
					content: renderedWithMarkers.replaceAll(
						PROVIDERS_PROMPT_MARKER,
						String(context.providers ?? ""),
					),
					stable: false,
				},
			];
		}

		const templateChunks = templateWithMarkers.split(PROVIDERS_PROMPT_MARKER);
		const renderedChunks = renderedWithMarkers.split(PROVIDERS_PROMPT_MARKER);
		const segments: PromptSegment[] = [];

		for (let i = 0; i < renderedChunks.length; i += 1) {
			const renderedChunk = renderedChunks[i] ?? "";
			if (renderedChunk.length > 0) {
				segments.push({
					content: renderedChunk,
					stable: this.isTemplateChunkStable(templateChunks[i] ?? ""),
				});
			}

			if (i < renderedChunks.length - 1) {
				segments.push(...providerSegments.map((segment) => ({ ...segment })));
			}
		}

		return this.mergePromptSegments(segments);
	}

	private joinPromptSegmentGroups(groups: PromptSegment[][]): PromptSegment[] {
		const result: PromptSegment[] = [];

		for (const group of groups) {
			const normalized = this.mergePromptSegments(group);
			if (normalized.length === 0) {
				continue;
			}

			if (result.length > 0) {
				result.push({ content: "\n\n", stable: false });
			}

			result.push(...normalized.map((segment) => ({ ...segment })));
		}

		return result;
	}

	private mergePromptSegments(segments: PromptSegment[]): PromptSegment[] {
		const merged: PromptSegment[] = [];

		for (const segment of segments) {
			if (segment.content.length === 0) {
				continue;
			}

			const previous = merged[merged.length - 1];
			if (previous && previous.stable === segment.stable) {
				previous.content += segment.content;
			} else {
				merged.push({ ...segment });
			}
		}

		return merged;
	}

	/**
	 * Convert double-brace Handlebars bindings to triple-brace (non-escaping).
	 *
	 * Handlebars uses:
	 * - `{{var}}` for HTML-escaped output
	 * - `{{{var}}}` for raw/unescaped output
	 *
	 * This function upgrades simple variable bindings to triple-brace so that
	 * special characters in state values don't get HTML-encoded in prompts.
	 *
	 * The regex preserves Handlebars helpers and special syntax:
	 * - `{{#if}}`, `{{/if}}` - block helpers (start with # or /)
	 * - `{{! comment }}` - comments (start with !)
	 * - `{{> partial}}` - partials (start with >)
	 * - `{{{already_raw}}}` - already triple-braced
	 * - `{{else}}` - else blocks
	 */
	private upgradeDoubleToTriple(tpl: string): string {
		// Pattern breakdown:
		// (?<!\{)      - not preceded by { (avoids matching inside {{{ )
		// \{\{         - match opening {{
		// (?!...)      - not followed by Handlebars special chars: # / ! > { else
		// (\s*)        - capture leading whitespace
		// (\S+?)       - capture variable name (non-greedy, non-whitespace)
		// (\s*)        - capture trailing whitespace
		// \}\}         - match closing }}
		// (?!\})       - not followed by } (avoids matching {{{ }}}
		const DOUBLE_BRACE_VAR =
			/(?<!\{)\{\{(?!#|\/|!|>|\{|else\b)(\s*)(\S+?)(\s*)\}\}(?!\})/g;

		return tpl.replace(DOUBLE_BRACE_VAR, "{{{$1$2$3}}}");
	}

	/**
	 * Normalize structured response (handle nested response objects).
	 *
	 * Some LLMs wrap their output in extra `{response: {...}}` layers.
	 * This recursively unwraps them up to a reasonable depth limit.
	 */
	private normalizeStructuredResponse(
		responseContent: Record<string, unknown> | null,
		depth = 0,
	): Record<string, unknown> | null {
		if (!responseContent) return null;

		// Safety limit to prevent infinite recursion on pathological input
		const MAX_UNWRAP_DEPTH = 3;
		if (depth >= MAX_UNWRAP_DEPTH) return responseContent;

		// If there's a nested 'response' object with the actual fields, unwrap it
		if (
			"response" in responseContent &&
			typeof responseContent.response === "object" &&
			responseContent.response !== null
		) {
			const nested = responseContent.response as Record<string, unknown>;
			// Only unwrap if nested has fields (not empty)
			if (Object.keys(nested).length > 0) {
				// Recursively unwrap in case of multiple nesting levels
				return this.normalizeStructuredResponse(nested, depth + 1);
			}
		}
		return responseContent;
	}

	private parseStructuredResponse(
		response: string,
		expectedFormat: StructuredResponseFormat,
	): Record<string, unknown> | null {
		const candidates = this.extractStructuredResponseCandidates(response);

		for (const candidate of candidates) {
			if (!candidate.formats.includes("JSON")) {
				continue;
			}

			const parsed = parseJSONObjectFromText(candidate.text);
			if (parsed) {
				if (candidate.source !== "raw" || expectedFormat !== "JSON") {
					this.logger.debug(
						`dynamicPromptExecFromState recovered JSON from ${candidate.source}`,
					);
				}
				return parsed;
			}
		}

		return null;
	}

	private extractStructuredResponseCandidates(
		response: string,
	): StructuredResponseCandidate[] {
		const seen = new Set<string>();
		const candidates: StructuredResponseCandidate[] = [];

		const addCandidate = (
			text: string,
			source: string,
			hints: StructuredResponseFormat[] = [],
		): void => {
			const trimmed = text.trim();
			if (!trimmed || seen.has(trimmed)) {
				return;
			}

			const formats = Array.from(
				new Set([...hints, ...this.detectStructuredResponseFormats(trimmed)]),
			);
			if (formats.length === 0) {
				return;
			}

			seen.add(trimmed);
			candidates.push({ text: trimmed, formats, source });
		};

		addCandidate(response, "raw");

		for (const match of response.matchAll(STRUCTURED_CODE_FENCE_PATTERN)) {
			const label = match[1]?.trim().toLowerCase() ?? "";
			const content = match[2]?.trim() ?? "";
			const hints: StructuredResponseFormat[] =
				label === "json" || label === "json5" ? ["JSON"] : [];
			addCandidate(content, label ? `fence:${label}` : "fence", hints);
		}

		const embeddedJson = this.extractEmbeddedJsonObject(response);
		if (embeddedJson) {
			addCandidate(embeddedJson, "embedded-json", ["JSON"]);
		}

		return candidates;
	}

	private detectStructuredResponseFormats(
		text: string,
	): StructuredResponseFormat[] {
		const trimmed = text.trim();
		const formats: StructuredResponseFormat[] = [];

		if (this.looksLikeJsonObject(trimmed)) {
			formats.push("JSON");
		}
		return formats;
	}

	private looksLikeJsonObject(text: string): boolean {
		const trimmed = text.trim();
		return (
			trimmed.startsWith("{") &&
			trimmed.includes("}") &&
			JSON_OBJECT_KEY_PATTERN.test(trimmed)
		);
	}

	private extractEmbeddedJsonObject(text: string): string | null {
		const trimmed = text.trim();
		if (this.looksLikeJsonObject(trimmed)) {
			return trimmed;
		}

		for (
			let start = text.indexOf("{");
			start !== -1;
			start = text.indexOf("{", start + 1)
		) {
			const candidate = this.extractBalancedJsonObject(text, start);
			if (candidate && this.looksLikeJsonObject(candidate)) {
				return candidate.trim();
			}
		}

		return null;
	}

	private extractBalancedJsonObject(
		text: string,
		startIndex: number,
	): string | null {
		let depth = 0;
		let inString = false;
		let stringQuote = "";
		let escaped = false;

		for (let index = startIndex; index < text.length; index++) {
			const char = text[index] ?? "";

			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (char === "\\") {
					escaped = true;
					continue;
				}
				if (char === stringQuote) {
					inString = false;
					stringQuote = "";
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = true;
				stringQuote = char;
				continue;
			}

			if (char === "{") {
				depth += 1;
				continue;
			}

			if (char !== "}") {
				continue;
			}

			depth -= 1;
			if (depth === 0) {
				return text.slice(startIndex, index + 1);
			}
			if (depth < 0) {
				return null;
			}
		}

		return null;
	}

	registerEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	registerEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;
	registerEvent(
		event: string,
		handler: (params: EventPayload) => Promise<void>,
	): void {
		if (!this.events[event]) {
			this.events[event] = [];
		}
		const eventHandlers = this.events[event];
		if (eventHandlers) {
			eventHandlers.push(
				handler as (
					params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
				) => Promise<void>,
			);
		}
	}

	unregisterEvent<T extends keyof EventPayloadMap>(
		event: T,
		handler: EventHandler<T>,
	): void;
	unregisterEvent<P extends EventPayload = EventPayload>(
		event: string,
		handler: (params: P) => Promise<void>,
	): void;
	unregisterEvent(
		event: string,
		handler: (params: EventPayload) => Promise<void>,
	): void {
		const handlers = this.events[event];
		if (!handlers) return;
		const filtered = handlers.filter((h) => h !== handler);
		if (filtered.length > 0) {
			this.events[event] = filtered;
		} else {
			delete this.events[event];
		}
	}

	getEvent(
		event: string,
	):
		| ((
				params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
		  ) => Promise<void>)[]
		| undefined {
		return this.events[event] as
			| ((
					params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
			  ) => Promise<void>)[]
			| undefined;
	}

	async emitEvent(event: string | string[], params: JsonValue | object) {
		const events = Array.isArray(event) ? event : [event];
		for (const eventName of events) {
			const eventHandlers = this.events[eventName];
			if (!eventHandlers) {
				continue;
			}
			let paramsWithRuntime:
				| EventPayloadMap[keyof EventPayloadMap]
				| EventPayload = {
				runtime: this,
				source: "runtime",
			};
			if (typeof params === "object" && params && params !== null) {
				const paramsObj = params as Record<string, JsonValue | object>;
				paramsWithRuntime = {
					...paramsObj,
					runtime: this,
					source:
						typeof paramsObj.source === "string" ? paramsObj.source : "runtime",
				} as EventPayloadMap[keyof EventPayloadMap] | EventPayload;
			}
			await Promise.all(
				eventHandlers.map((handler) =>
					handler(paramsWithRuntime as EventPayloadMap[keyof EventPayloadMap]),
				),
			);
		}
	}

	/**
	 * Diagnostic boundary for failures outside the action path (#12263). Logs
	 * with a `[scope]` prefix, records the failure in the bounded ring, emits
	 * {@link EventType.ERROR_REPORTED}, and forwards it into the
	 * AgentEventService `"error"` stream when that service is registered.
	 *
	 * Self-safe: never throws. A failure inside this method (or inside an
	 * `ERROR_REPORTED` handler it triggers) is caught and logged as a warning
	 * without re-entering `reportError`, guarded by {@link inReportError}.
	 */
	reportError(
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	): void {
		if (this.inReportError) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — a failure while
			// reporting must not recurse; warn-only and return.
			this.logger.warn(
				{ src: "agent", scope },
				`[${scope}] reportError re-entered while already reporting; dropping nested error`,
			);
			return;
		}
		this.inReportError = true;
		try {
			const normalized = toElizaError(error);
			const merged: Record<string, unknown> | undefined =
				context || normalized.context
					? { ...normalized.context, ...context }
					: undefined;
			const runId =
				typeof merged?.runId === "string" ? (merged.runId as UUID) : undefined;
			const roomId =
				typeof merged?.roomId === "string"
					? (merged.roomId as UUID)
					: undefined;

			this.logger.error(
				{
					src: "agent",
					scope,
					code: normalized.code,
					severity: normalized.severity,
					context: merged,
					err: normalized,
				},
				`[${scope}] ${normalized.message}`,
			);

			const entry: ReportedError = {
				scope,
				code: normalized.code,
				message: normalized.message,
				context: merged,
				at: Date.now(),
			};
			this.reportedErrors.push(entry);
			if (this.reportedErrors.length > AgentRuntime.REPORTED_ERROR_RING_CAP) {
				this.reportedErrors.splice(
					0,
					this.reportedErrors.length - AgentRuntime.REPORTED_ERROR_RING_CAP,
				);
			}

			this.forwardToAgentEventStream(entry, runId);

			// Fire-and-forget: emitEvent is async but reportError is a sync
			// diagnostic one-liner. A rejected emit (bad handler) is swallowed to
			// the logger here — it must not surface as an unhandled rejection and
			// must not re-enter reportError.
			void this.emitEvent(EventType.ERROR_REPORTED, {
				runtime: this,
				source: scope,
				scope,
				code: normalized.code,
				message: normalized.message,
				context: merged,
				runId,
				roomId,
			}).catch((emitErr) => {
				// error-policy:J7 diagnostics-must-not-kill-the-loop — a broken
				// ERROR_REPORTED handler is logged, never re-reported.
				this.logger.warn(
					{ src: "agent", scope, err: emitErr },
					`[${scope}] ERROR_REPORTED emit failed`,
				);
			});
		} catch (reportErr) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — reportError is
			// the diagnostic boundary; its own failure may only warn.
			this.logger.warn(
				{ src: "agent", scope, err: reportErr },
				`[${scope}] reportError itself failed`,
			);
		} finally {
			this.inReportError = false;
		}
	}

	/** Snapshot copy of the reported-error ring (newest last). */
	getRecentReportedErrors(): ReportedError[] {
		return this.reportedErrors.map((entry) => ({ ...entry }));
	}

	/**
	 * Forward a reported error into the AgentEventService `"error"` stream when
	 * that service is registered. Duck-typed via ServiceType.AGENT_EVENT so core
	 * keeps no import edge to the service class. Best-effort: a missing or
	 * throwing service is warn-only (still inside the reportError latch).
	 */
	private forwardToAgentEventStream(
		entry: ReportedError,
		runId: UUID | undefined,
	): void {
		const service = this.getService(ServiceType.AGENT_EVENT) as {
			emit?: (event: {
				runId: string;
				stream: string;
				data: Record<string, unknown>;
			}) => void;
		} | null;
		if (!service || typeof service.emit !== "function") return;
		try {
			service.emit({
				runId: runId ?? "runtime",
				stream: "error",
				data: {
					type: "error",
					scope: entry.scope,
					code: entry.code,
					message: entry.message,
					context: entry.context,
					recoverable: true,
				},
			});
		} catch (streamErr) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — the event
			// stream is a diagnostic sink; a failure here may only warn.
			this.logger.warn(
				{ src: "agent", scope: entry.scope, err: streamErr },
				`[${entry.scope}] agent-event error stream forward failed`,
			);
		}
	}

	/**
	 * True while embedding generation is disabled because every registered
	 * TEXT_EMBEDDING provider failed the dimension probe. While true, memory
	 * writes persist without vectors (recall over new memories is degraded)
	 * rather than emitting vectors the SQL adapter would silently drop against
	 * a default-sized column. Cleared by the next successful
	 * {@link ensureEmbeddingDimension} (e.g. the deferred boot re-probe).
	 */
	isEmbeddingGenerationDisabled(): boolean {
		return this.embeddingGenerationDisabledReason !== null;
	}

	private disableEmbeddingGeneration(reason: string): void {
		this.embeddingGenerationDisabledReason = reason;
		this.embeddingSkipWarned = false;
	}

	private enableEmbeddingGeneration(): void {
		if (this.embeddingGenerationDisabledReason !== null) {
			this.logger.info(
				{ src: "agent", agentId: this.agentId },
				"TEXT_EMBEDDING provider recovered; embedding generation re-enabled",
			);
		}
		this.embeddingGenerationDisabledReason = null;
		this.embeddingSkipWarned = false;
	}

	/**
	 * Once-latch warn for skipped embedding generation: the first skipped write
	 * logs a structured warning, subsequent skips stay quiet until the flag is
	 * cleared and re-set (a fresh degradation event warns again).
	 */
	private warnEmbeddingGenerationSkipped(): void {
		if (this.embeddingSkipWarned) {
			return;
		}
		this.embeddingSkipWarned = true;
		this.logger.warn(
			{
				src: "agent",
				agentId: this.agentId,
				reason: this.embeddingGenerationDisabledReason,
			},
			"Embedding generation is disabled (every TEXT_EMBEDDING provider failed the dimension probe); memory writes are persisted WITHOUT vectors — recall over new memories is degraded until a provider recovers",
		);
	}

	async ensureEmbeddingDimension() {
		if (!this.adapter) {
			throw new Error(
				"Database adapter not initialized before ensureEmbeddingDimension",
			);
		}
		const registrations = this.resolveModelRegistrations(
			ModelType.TEXT_EMBEDDING,
		);
		if (registrations.length === 0) {
			throw new Error("No TEXT_EMBEDDING model registered");
		}

		// Probe every registered TEXT_EMBEDDING provider in the same priority
		// order useModel resolves them. The probe passes null; handlers return a
		// zero-filled vector of their real output width. A provider that cannot
		// answer the null probe cannot produce usable vectors either, so ANY
		// probe failure — not just a rate limit — advances to the next
		// registration. First success wins: it sizes the adapter's vector column
		// and pins that provider for subsequent embedding calls, so the column
		// width and the vectors written to it always come from the same provider.
		const attempts: EmbeddingProbeAttempt[] = [];
		const probedProviders = new Set<string>();
		let allFailuresBenign = true;
		for (const registration of registrations) {
			if (probedProviders.has(registration.provider)) {
				continue;
			}
			probedProviders.add(registration.provider);

			let embedding: unknown;
			try {
				embedding = await this.useModel(
					ModelType.TEXT_EMBEDDING,
					null,
					registration.provider,
				);
			} catch (error) {
				if (!(error instanceof NoModelProviderConfiguredError)) {
					allFailuresBenign = false;
				}
				attempts.push({
					provider: registration.provider,
					modelKey: registration.modelKey,
					error: error instanceof Error ? error.message : String(error),
				});
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						provider: registration.provider,
						error: error instanceof Error ? error.message : String(error),
					},
					"TEXT_EMBEDDING provider failed the dimension probe; trying next registered provider",
				);
				continue;
			}
			if (!Array.isArray(embedding) || embedding.length === 0) {
				allFailuresBenign = false;
				attempts.push({
					provider: registration.provider,
					modelKey: registration.modelKey,
					error: `Invalid embedding received (${Array.isArray(embedding) ? "empty array" : typeof embedding})`,
				});
				this.logger.warn(
					{
						src: "agent",
						agentId: this.agentId,
						provider: registration.provider,
					},
					"TEXT_EMBEDDING provider returned an invalid probe embedding; trying next registered provider",
				);
				continue;
			}

			await this.adapter.ensureEmbeddingDimension(embedding.length);
			this.pinnedEmbeddingProvider = registration.provider;
			this.enableEmbeddingGeneration();
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					dimension: embedding.length,
					provider: registration.provider,
					failedProviders: attempts.map((attempt) => attempt.provider),
				},
				"Embedding dimension set",
			);
			return;
		}

		// Every registered handler reported "no backing provider configured"
		// (e.g. a cloud proxy handler before login). Nothing can emit vectors,
		// so a default-width column cannot cause a dimension mismatch — keep the
		// long-standing benign skip.
		if (allFailuresBenign) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"No backing TEXT_EMBEDDING provider registered, skipping embedding setup",
			);
			return;
		}

		// All probes failed for real. Disable embedding generation so memory
		// writes skip vector generation coherently (no silent drops downstream),
		// and surface a typed error carrying every provider's failure.
		const probeError = new EmbeddingDimensionProbeError(attempts);
		this.disableEmbeddingGeneration(probeError.message);
		throw probeError;
	}

	registerTaskWorker(taskHandler: TaskWorker): void {
		if (this.taskWorkers.has(taskHandler.name)) {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId, task: taskHandler.name },
				"Task worker already registered, overwriting",
			);
		}
		this.taskWorkers.set(taskHandler.name, taskHandler);
	}

	getTaskWorker(name: string): TaskWorker | undefined {
		return this.taskWorkers.get(name);
	}

	unregisterTaskWorker(name: string): boolean {
		return this.taskWorkers.delete(name);
	}

	get db(): object {
		return this.adapter.db;
	}
	async init(): Promise<void> {
		await this.adapter.initialize();
	}
	/**
	 * Closes the database adapter. Call after stop() for full teardown (stops services then closes DB/connection).
	 */
	async close(): Promise<void> {
		if (this.adapter) {
			await this.adapter.close();
		}
	}
	async getAgent(agentId: UUID): Promise<Agent | null> {
		const agents = await this.adapter.getAgentsByIds([agentId]);
		return agents[0] ?? null;
	}
	async getAgents(): Promise<Partial<Agent>[]> {
		return this.adapter.getAgents();
	}
	async createAgent(agent: Partial<Agent>): Promise<boolean> {
		const ids = await this.adapter.createAgents([agent]);
		return ids.length > 0;
	}
	async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
		return this.adapter.updateAgents([{ agentId, agent }]);
	}
	async deleteAgent(agentId: UUID): Promise<boolean> {
		return this.adapter.deleteAgents([agentId]);
	}
	async countAgents(): Promise<number> {
		return this.adapter.countAgents();
	}
	async cleanupAgents(): Promise<void> {
		return this.adapter.cleanupAgents();
	}

	// Batch agent methods
	async getAgentsByIds(agentIds: UUID[]): Promise<Agent[]> {
		return this.adapter.getAgentsByIds(agentIds);
	}
	async createAgents(agents: Partial<Agent>[]): Promise<UUID[]> {
		return this.adapter.createAgents(agents);
	}
	async upsertAgents(agents: Partial<Agent>[]): Promise<void> {
		return this.adapter.upsertAgents(agents);
	}
	async updateAgents(
		updates: Array<{ agentId: UUID; agent: Partial<Agent> }>,
	): Promise<boolean> {
		return this.adapter.updateAgents(updates);
	}
	async deleteAgents(agentIds: UUID[]): Promise<boolean> {
		return this.adapter.deleteAgents(agentIds);
	}

	async ensureAgentExists(agent: Partial<Agent>): Promise<Agent> {
		if (!agent.id) {
			throw new Error("Agent id is required");
		}

		// WHY upsert instead of get-check-create: Eliminates race condition where
		// two concurrent calls could both see agent doesn't exist and both try to
		// create it. Upsert is atomic (single SQL statement), so the database
		// guarantees only one succeeds.

		// Fetch existing agent to perform intelligent merge (if it exists)
		const existingAgent =
			(await this.adapter.getAgentsByIds([agent.id]))[0] ?? null;

		let agentToUpsert: Partial<Agent>;

		if (existingAgent) {
			// Merge DB-persisted settings with character configuration
			// Priority: DB (persisted runtime settings) < character.json (file overrides)
			const mergedSettings = {
				...existingAgent.settings, // Keep all DB-persisted settings
				...agent.settings, // Override only keys present in character.json
			};

			// Deep merge secrets to preserve runtime-generated secrets
			const existingSecrets =
				existingAgent.secrets && typeof existingAgent.secrets === "object"
					? existingAgent.secrets
					: {};
			const existingSettingsSecrets =
				existingAgent.settings?.secrets &&
				typeof existingAgent.settings.secrets === "object"
					? existingAgent.settings.secrets
					: {};
			const agentSecrets =
				agent.secrets && typeof agent.secrets === "object" ? agent.secrets : {};
			const agentSettingsSecrets =
				agent.settings?.secrets && typeof agent.settings.secrets === "object"
					? agent.settings.secrets
					: {};
			const mergedSecrets = {
				...existingSecrets,
				...existingSettingsSecrets,
				...agentSecrets,
				...agentSettingsSecrets,
			};

			if (Object.keys(mergedSecrets).length > 0) {
				mergedSettings.secrets = mergedSecrets;
			}

			agentToUpsert = {
				...existingAgent, // Keep all DB-persisted data
				...agent, // Override with character.json values
				settings: mergedSettings, // Use intelligently merged settings
				id: agent.id,
				updatedAt: Date.now(),
				secrets:
					Object.keys(mergedSecrets).length > 0 ? mergedSecrets : agent.secrets,
			};
		} else {
			// No existing agent - upsert will insert it
			agentToUpsert = {
				...agent,
				id: agent.id,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as Agent;
		}

		// Atomic upsert - handles both insert and update cases
		await this.adapter.upsertAgents([agentToUpsert]);

		// Fetch and return the final state
		const refreshedAgent =
			(await this.adapter.getAgentsByIds([agent.id]))[0] ?? null;

		if (!refreshedAgent) {
			throw new Error(`Failed to retrieve agent after upsert: ${agent.id}`);
		}

		this.logger.debug(
			{ src: "agent", agentId: agent.id },
			existingAgent ? "Agent updated on restart" : "Agent created",
		);
		return refreshedAgent;
	}
	async getEntityById(entityId: UUID): Promise<Entity | null> {
		const entities = await this.adapter.getEntitiesByIds([entityId]);
		if (!entities.length) return null;
		return entities[0];
	}

	async getEntitiesForRooms(
		roomIds: UUID[],
		includeComponents?: boolean,
	): Promise<import("./types/database").EntitiesForRoomsResult> {
		return this.adapter.getEntitiesForRooms(roomIds, includeComponents);
	}

	async getEntitiesForRoom(
		roomId: UUID,
		includeComponents?: boolean,
	): Promise<Entity[]> {
		const result = await this.adapter.getEntitiesForRooms(
			[roomId],
			includeComponents,
		);
		return result[0]?.entities ?? [];
	}
	async createEntity(entity: Entity): Promise<boolean> {
		if (!entity.agentId) {
			entity.agentId = this.agentId;
		}
		const ids = await this.createEntities([entity]);
		return ids.length > 0;
	}

	async createEntities(entities: Entity[]): Promise<UUID[]> {
		entities.forEach((e) => {
			e.agentId = this.agentId;
		});
		const result = await this.adapter.createEntities(entities);
		// Some adapters (e.g. plugin-sql) return boolean instead of UUID[].
		// Normalize to UUID[] so callers and wrappers get a consistent contract.
		if (Array.isArray(result)) return result;
		if (result) return entities.map((e) => e.id as UUID);
		return [];
	}
	async upsertEntities(entities: Entity[]): Promise<void> {
		entities.forEach((e) => {
			e.agentId = this.agentId;
		});
		return this.adapter.upsertEntities(entities);
	}

	async getComponents(
		entityId: UUID,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return this.adapter.getComponentsForEntities(
			[entityId],
			worldId,
			sourceEntityId,
		);
	}

	async getComponentsByNaturalKeys(
		keys: Array<{
			entityId: UUID;
			type: string;
			worldId?: UUID;
			sourceEntityId?: UUID;
		}>,
	): Promise<(Component | null)[]> {
		return this.adapter.getComponentsByNaturalKeys(keys);
	}

	async getComponentsForEntities(
		entityIds: UUID[],
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component[]> {
		return this.adapter.getComponentsForEntities(
			entityIds,
			worldId,
			sourceEntityId,
		);
	}
	async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
		if (memory.embedding) {
			return memory;
		}
		const memoryText = memory.content.text;
		if (!memoryText) {
			throw new Error("Cannot generate embedding: Memory content is empty");
		}
		if (this.embeddingGenerationDisabledReason !== null) {
			// Every TEXT_EMBEDDING provider failed the dimension probe, so the
			// vector column was never sized for this runtime. Skip generation
			// explicitly (warn once) instead of producing a vector the SQL
			// adapter would silently drop on dimension mismatch (#8769).
			this.warnEmbeddingGenerationSkipped();
			return memory;
		}
		memory.embedding = await this.useModel(ModelType.TEXT_EMBEDDING, {
			text: memoryText,
		});
		return memory;
	}

	/**
	 * Queue a memory for embedding generation. If companionUrl is set, POSTs to companion
	 * and returns without waiting (fire-and-forget). WHY: Thin runtime doesn't block on embedding.
	 */
	async queueEmbeddingGeneration(
		memory: Memory,
		priority?: "high" | "normal" | "low",
	): Promise<void> {
		priority = priority || "normal";
		if (!memory || memory.embedding || !memory.content.text) {
			return;
		}
		if (this.embeddingGenerationDisabledReason !== null) {
			// See addEmbeddingToMemory: no provider passed the dimension probe,
			// so queueing would only produce per-item generation failures (or
			// silently dropped vectors). Skip explicitly, warn once.
			this.warnEmbeddingGenerationSkipped();
			return;
		}

		if (this.companionUrl) {
			const url = `${this.companionUrl.replace(/\/$/, "")}/embedding-generation`;
			void this.fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentId: this.agentId,
					memory,
					priority,
					runId: this.getCurrentRunId(),
				}),
			}).catch((err) =>
				// error-policy:J7 diagnostics-must-not-kill-the-loop — offloading
				// embedding generation to the companion is fire-and-forget, but a
				// dead companion must surface (embeddings would silently stop).
				this.reportError("AgentRuntime.companionEmbedding", err, {
					url,
					agentId: this.agentId,
				}),
			);
			return;
		}

		void this.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
			runtime: this,
			memory,
			priority,
			source: "runtime",
			retryCount: 0,
			maxRetries: 3,
			runId: this.getCurrentRunId(),
		}).catch((error) => {
			this.logger.warn(
				{
					src: "runtime",
					error: error instanceof Error ? error.message : String(error),
					memoryId: memory.id,
					priority,
				},
				"Embedding generation request failed",
			);
		});
	}
	async getMemories(params: {
		entityId?: UUID;
		agentId?: UUID;
		roomId?: UUID;
		limit?: number;
		count?: number;
		offset?: number;
		unique?: boolean;
		tableName: string;
		start?: number;
		end?: number;
		worldId?: UUID;
		metadata?: Record<string, unknown>;
		textContains?: string;
		orderBy?: "createdAt";
		orderDirection?: "asc" | "desc";
		includeEmbedding?: boolean;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		return this.adapter.getMemories({
			...params,
			limit: params.limit ?? params.count,
			tableName: params.tableName,
		});
	}
	async getAllMemories(): Promise<Memory[]> {
		// Every partition the platform writes memory rows into. This list is a
		// load-bearing contract: the media GC builds its referenced-set from it
		// (packages/agent media-runtime), so a partition missing here makes that
		// partition's media references invisible to the sweep and its files get
		// deleted after the grace window — "transcripts" rows anchor retained
		// recordings via the audioUrl inside content.transcript (#14751). It also
		// bounds clearAllAgentMemories: an unlisted partition survives a wipe.
		const tables = [
			"memories",
			"messages",
			"facts",
			"documents",
			"transcripts",
		];
		const allMemories: Memory[] = [];

		for (const tableName of tables) {
			const memories = await this.adapter.getMemories({
				agentId: this.agentId,
				tableName,
				limit: 10000, // Get a large number to fetch all
			});
			allMemories.push(...memories);
		}

		return allMemories;
	}
	async getMemoriesByIds(ids: UUID[], tableName?: string): Promise<Memory[]> {
		return this.adapter.getMemoriesByIds(ids, tableName);
	}
	async getMemoriesByRoomIds(params: {
		tableName: string;
		roomIds: UUID[];
		limit?: number;
		offset?: number;
		textContains?: string;
		includeEmbedding?: boolean;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		return this.adapter.getMemoriesByRoomIds(params);
	}
	async searchMessages(params: {
		roomIds: UUID[];
		query: string;
		tableName?: string;
		limit?: number;
		offset?: number;
		since?: number;
		until?: number;
		accessContext?: AccessContext;
	}): Promise<MessageSearchHit[]> {
		return this.adapter.searchMessages(params);
	}

	async getCachedEmbeddings(params: {
		query_table_name: string;
		query_threshold: number;
		query_input: string;
		query_field_name: string;
		query_field_sub_name: string;
		query_match_count: number;
	}): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
		return this.adapter.getCachedEmbeddings(params);
	}
	async searchMemories(params: {
		embedding: number[];
		query?: string;
		match_threshold?: number;
		count?: number;
		limit?: number;
		roomId?: UUID;
		unique?: boolean;
		worldId?: UUID;
		entityId?: UUID;
		tableName: string;
		accessContext?: AccessContext;
	}): Promise<Memory[]> {
		const memories = await this.adapter.searchMemories({
			...params,
			tableName: params.tableName,
		});
		if (params.query) {
			const rerankedMemories = await this.rerankMemories(
				params.query,
				memories,
			);
			return rerankedMemories;
		}
		return memories;
	}
	async rerankMemories(query: string, memories: Memory[]): Promise<Memory[]> {
		const docs = memories.map((memory) => ({
			title: memory.id,
			content: memory.content.text,
		}));
		const bm25 = new BM25(docs);
		const results = bm25.search(query, memories.length);
		const rankedIndexes = new Set(results.map((result) => result.index));
		const rerankedMemories = results.map((result) => memories[result.index]);

		// BM25 is a reranker, not a filter. Keep zero-overlap vector hits
		// after scored matches so semantic recall cannot disappear.
		for (let index = 0; index < memories.length; index++) {
			if (!rankedIndexes.has(index)) {
				rerankedMemories.push(memories[index]);
			}
		}

		return rerankedMemories;
	}
	/**
	 * Get the secrets to redact from character settings.
	 * Returns an empty object if no secrets are configured.
	 */
	private getSecretsForRedaction(): Record<string, string> {
		const secrets = this.character.settings?.secrets;
		if (!secrets || typeof secrets !== "object") {
			return {};
		}
		// Filter to only include string values
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(secrets)) {
			if (typeof value === "string" && value.length > 0) {
				result[key] = value;
			}
		}
		return result;
	}

	/**
	 * Redact secrets from text content.
	 * This prevents character secrets from appearing in outputs or memories.
	 */
	redactSecrets(text: string): string {
		if (!text) {
			return text;
		}
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length === 0) {
			return text;
		}
		return redactWithSecrets(text, { secrets, applyPatterns: true });
	}

	async clearAllAgentMemories(): Promise<void> {
		this.logger.info(
			{ src: "agent", agentId: this.agentId },
			"Clearing all memories",
		);

		const allMemories = await this.getAllMemories();
		const memoryIds = allMemories
			.map((memory) => memory.id)
			.filter((id): id is UUID => id !== undefined);

		if (memoryIds.length === 0) {
			this.logger.debug(
				{ src: "agent", agentId: this.agentId },
				"No memories to delete",
			);
			return;
		}

		await this.adapter.deleteMemories(memoryIds);
		this.logger.info(
			{ src: "agent", agentId: this.agentId, count: memoryIds.length },
			"Memories cleared",
		);
	}
	async deleteAllMemories(roomIds: UUID[], tableName: string): Promise<void> {
		await this.adapter.deleteAllMemories(roomIds, tableName);
	}
	async countMemories(
		roomIdOrParams:
			| UUID
			| {
					roomId?: UUID;
					unique?: boolean;
					tableName?: string;
					entityId?: UUID;
					agentId?: UUID;
					metadata?: Record<string, unknown>;
			  },
		unique?: boolean,
		tableName?: string,
	): Promise<number> {
		if (typeof roomIdOrParams === "string") {
			return this.adapter.countMemories({
				roomIds: [roomIdOrParams as UUID],
				unique,
				tableName: tableName ?? "messages",
			});
		}
		return this.adapter.countMemories({
			roomIds: roomIdOrParams.roomId ? [roomIdOrParams.roomId] : undefined,
			unique: roomIdOrParams.unique,
			tableName: roomIdOrParams.tableName ?? "messages",
			entityId: roomIdOrParams.entityId,
			agentId: roomIdOrParams.agentId,
			metadata: roomIdOrParams.metadata,
		});
	}
	async getLogs(params: {
		entityId?: UUID;
		roomId?: UUID;
		type?: string;
		limit?: number;
		offset?: number;
	}): Promise<Log[]> {
		return this.adapter.getLogs(params);
	}
	// Batch log methods
	async getLogsByIds(logIds: UUID[]): Promise<Log[]> {
		return this.adapter.getLogsByIds(logIds);
	}

	async createLogs(
		params: Array<{
			body: LogBody;
			entityId: UUID;
			roomId: UUID;
			type: string;
		}>,
	): Promise<void> {
		return this.adapter.createLogs(params);
	}

	async updateLogs(
		logs: Array<{ id: UUID; updates: Partial<Log> }>,
	): Promise<void> {
		return this.adapter.updateLogs(logs);
	}

	async deleteLogs(logIds: UUID[]): Promise<void> {
		return this.adapter.deleteLogs(logIds);
	}
	async createWorld(world: World): Promise<UUID> {
		const ids = await this.adapter.createWorlds([world]);
		return ids[0];
	}
	async getWorld(id: UUID): Promise<World | null> {
		const worlds = await this.adapter.getWorldsByIds([id]);
		return worlds[0] ?? null;
	}
	async deleteWorld(worldId: UUID): Promise<void> {
		await this.adapter.deleteWorlds([worldId]);
	}
	async getAllWorlds(): Promise<World[]> {
		return this.adapter.getAllWorlds();
	}
	async updateWorld(world: World): Promise<void> {
		await this.adapter.updateWorlds([world]);
	}

	// Batch world methods
	async getWorldsByIds(worldIds: UUID[]): Promise<World[]> {
		return this.adapter.getWorldsByIds(worldIds);
	}
	async createWorlds(worlds: World[]): Promise<UUID[]> {
		return this.adapter.createWorlds(worlds);
	}
	async upsertWorlds(worlds: World[]): Promise<void> {
		return this.adapter.upsertWorlds(worlds);
	}
	async deleteWorlds(worldIds: UUID[]): Promise<void> {
		await this.adapter.deleteWorlds(worldIds);
	}
	async updateWorlds(worlds: World[]): Promise<void> {
		await this.adapter.updateWorlds(worlds);
	}

	async getRoom(roomId: UUID): Promise<Room | null> {
		const rooms = await this.adapter.getRoomsByIds([roomId]);
		if (!rooms.length) return null;
		return rooms[0];
	}

	async getRoomsByIds(roomIds: UUID[]): Promise<Room[]> {
		return this.adapter.getRoomsByIds(roomIds);
	}
	async createRoom({
		id,
		name,
		source,
		type,
		channelId,
		messageServerId,
		worldId,
	}: Room): Promise<UUID> {
		if (!worldId) throw new Error("worldId is required");
		const res = await this.adapter.createRooms([
			{
				id,
				name,
				source,
				type,
				channelId,
				messageServerId,
				worldId,
			},
		]);
		if (!res.length) throw new Error("Failed to create room");
		return res[0];
	}

	async createRooms(rooms: Room[]): Promise<UUID[]> {
		return this.adapter.createRooms(rooms);
	}
	async upsertRooms(rooms: Room[]): Promise<void> {
		return this.adapter.upsertRooms(rooms);
	}

	async deleteRoomsByWorldId(worldId: UUID): Promise<void> {
		await this.adapter.deleteRoomsByWorldIds([worldId]);
	}
	async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
		return this.adapter.getRoomsForParticipants([entityId]);
	}

	async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
		return this.adapter.getRoomsForParticipants(entityIds);
	}

	// deprecate this one
	async getRooms(worldId: UUID): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds([worldId]);
	}

	async getRoomsByWorld(worldId: UUID): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds([worldId]);
	}
	async getParticipantUserState(
		roomId: UUID,
		entityId: UUID,
	): Promise<"FOLLOWED" | "MUTED" | null> {
		const results = await this.adapter.getParticipantUserStates([
			{ roomId, entityId },
		]);
		return results[0] ?? null;
	}
	async updateParticipantUserState(
		roomId: UUID,
		entityId: UUID,
		state: "FOLLOWED" | "MUTED" | null,
	): Promise<void> {
		await this.adapter.updateParticipantUserStates([
			{ roomId, entityId, state },
		]);
	}

	async getParticipantUserStates(
		pairs: Array<{ roomId: UUID; entityId: UUID }>,
	): Promise<("FOLLOWED" | "MUTED" | null)[]> {
		return this.adapter.getParticipantUserStates(pairs);
	}

	async updateParticipantUserStates(
		updates: Array<{
			roomId: UUID;
			entityId: UUID;
			state: "FOLLOWED" | "MUTED" | null;
		}>,
	): Promise<void> {
		await this.adapter.updateParticipantUserStates(updates);
	}
	async getRelationships(params: {
		entityIds?: UUID[];
		entityId?: UUID;
		tags?: string[];
		limit?: number;
		offset?: number;
	}): Promise<Relationship[]> {
		const entityIds =
			Array.isArray(params.entityIds) && params.entityIds.length > 0
				? params.entityIds
				: params.entityId
					? [params.entityId]
					: [];
		return this.adapter.getRelationships({
			entityIds,
			tags: params.tags,
			limit: params.limit,
			offset: params.offset,
		});
	}
	// Batch cache methods
	async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
		return this.adapter.getCaches<T>(keys);
	}

	async setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean> {
		return this.adapter.setCaches<T>(entries);
	}

	async deleteCaches(keys: string[]): Promise<boolean> {
		return this.adapter.deleteCaches(keys);
	}

	async getTasks(params: {
		roomId?: UUID;
		tags?: string[];
		entityId?: UUID;
	}): Promise<Task[]> {
		return this.adapter.getTasks({ ...params, agentIds: [this.agentId] });
	}
	async getTasksByName(name: string): Promise<Task[]> {
		return this.adapter.getTasksByName(name);
	}

	/** WHY fire-and-forget: Notify companion that tasks changed so it can poll/process; no need to block. */
	private _notifyCompanionTasksDirty(): void {
		if (!this.companionUrl) return;
		const url = `${this.companionUrl.replace(/\/$/, "")}/task-dirty`;
		void this.fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ agentId: this.agentId }),
		}).catch((err) =>
			// error-policy:J7 diagnostics-must-not-kill-the-loop — the notify is
			// fire-and-forget (no need to block), but a dead companion means tasks
			// stop being processed, so the failure must surface.
			this.reportError("AgentRuntime.companionTasksDirty", err, {
				url,
				agentId: this.agentId,
			}),
		);
	}

	/**
	 * Nudge the local TaskService (same process) so its dirty-gated tick re-queries the DB.
	 * WHY: the companion POST above only reaches a REMOTE receiver; without this, in-process
	 * task mutations never re-arm the tick and tasks created after boot are never seen.
	 */
	private _markLocalTasksDirty(): void {
		const taskService = this.getService<TaskService>(ServiceType.TASK);
		taskService?.markDirty();
	}

	async createTask(task: Task): Promise<UUID> {
		const ids = await this.adapter.createTasks([task]);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
		return ids[0];
	}

	async getTask(id: UUID): Promise<Task | null> {
		const tasks = await this.adapter.getTasksByIds([id]);
		return tasks[0] ?? null;
	}

	async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
		await this.adapter.updateTasks([{ id, task }]);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
	}

	async deleteTask(id: UUID): Promise<void> {
		await this.adapter.deleteTasks([id]);
		this._markLocalTasksDirty();
	}

	async log(params: {
		body: LogBody;
		entityId: UUID;
		roomId: UUID;
		type: string;
	}): Promise<void> {
		return this.adapter.createLogs([params]);
	}

	async deleteLog(logId: UUID): Promise<void> {
		return this.adapter.deleteLogs([logId]);
	}

	async getCache<T>(key: string): Promise<T | undefined> {
		const caches = await this.adapter.getCaches<T>([key]);
		return caches.get(key);
	}

	async setCache<T>(key: string, value: T): Promise<boolean> {
		return this.adapter.setCaches<T>([{ key, value }]);
	}

	async deleteCache(key: string): Promise<boolean> {
		return this.adapter.deleteCaches([key]);
	}

	// Batch task methods
	async createTasks(tasks: Task[]): Promise<UUID[]> {
		const ids = await this.adapter.createTasks(tasks);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
		return ids;
	}

	async getTasksByIds(taskIds: UUID[]): Promise<Task[]> {
		return this.adapter.getTasksByIds(taskIds);
	}

	async updateTasks(
		updates: Array<{ id: UUID; task: Partial<Task> }>,
	): Promise<void> {
		await this.adapter.updateTasks(updates);
		this._markLocalTasksDirty();
		this._notifyCompanionTasksDirty();
	}

	async deleteTasks(taskIds: UUID[]): Promise<void> {
		await this.adapter.deleteTasks(taskIds);
		this._markLocalTasksDirty();
	}

	/**
	 * Run callback in a database transaction. Forwards options.entityContext to the adapter.
	 * WHY forward only: RLS (withEntityContext) is implemented in the adapter (e.g. plugin-sql Postgres);
	 * runtime does not touch Postgres or connection context.
	 */
	async transaction<T>(
		callback: (tx: IDatabaseAdapter<object>) => Promise<T>,
		options?: { entityContext?: UUID },
	): Promise<T> {
		return this.adapter.transaction(callback, options);
	}

	async queryEntities(params: {
		componentType?: string;
		componentDataFilter?: Record<string, unknown>;
		agentId?: UUID;
		entityIds?: UUID[];
		worldId?: UUID;
		limit?: number;
		offset?: number;
		includeAllComponents?: boolean;
		entityContext?: UUID;
	}): Promise<Entity[]> {
		return this.adapter.queryEntities({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Batch entity methods
	async getEntitiesByIds(entityIds: UUID[]): Promise<Entity[]> {
		return this.adapter.getEntitiesByIds(entityIds);
	}

	async updateEntities(entities: Entity[]): Promise<void> {
		return this.adapter.updateEntities(entities);
	}

	async deleteEntities(entityIds: UUID[]): Promise<void> {
		return this.adapter.deleteEntities(entityIds);
	}
	async searchEntitiesByName(params: {
		query: string;
		agentId?: UUID;
		limit?: number;
	}): Promise<Entity[]> {
		return this.adapter.searchEntitiesByName({
			query: params.query,
			agentId: params.agentId ?? this.agentId,
			limit: params.limit,
		});
	}
	async getEntitiesByNames(params: {
		names: string[];
		agentId?: UUID;
	}): Promise<Entity[]> {
		return this.adapter.getEntitiesByNames({
			names: params.names,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// Single-item entity wrapper
	async updateEntity(entity: Entity): Promise<void> {
		return this.adapter.updateEntities([entity]);
	}

	// Batch component methods
	async createComponents(components: Component[]): Promise<UUID[]> {
		return this.adapter.createComponents(components);
	}

	async getComponentsByIds(componentIds: UUID[]): Promise<Component[]> {
		return this.adapter.getComponentsByIds(componentIds);
	}

	async updateComponents(components: Component[]): Promise<void> {
		return this.adapter.updateComponents(components);
	}

	async deleteComponents(componentIds: UUID[]): Promise<void> {
		return this.adapter.deleteComponents(componentIds);
	}

	// Single-item component wrappers
	async createComponent(component: Component): Promise<boolean> {
		const ids = await this.adapter.createComponents([component]);
		return ids.length > 0;
	}

	async getComponent(
		entityId: UUID,
		type: string,
		worldId?: UUID,
		sourceEntityId?: UUID,
	): Promise<Component | null> {
		// This one doesn't have a batch equivalent for the entity+type query
		// It uses the getComponents query method
		const results = await this.adapter.getComponentsByNaturalKeys([
			{ entityId, type, worldId, sourceEntityId },
		]);
		return results[0] ?? null;
	}

	async updateComponent(component: Component): Promise<void> {
		return this.adapter.updateComponents([component]);
	}

	async deleteComponent(componentId: UUID): Promise<void> {
		return this.adapter.deleteComponents([componentId]);
	}

	async upsertComponent(component: Component): Promise<void> {
		return this.adapter.upsertComponents([component]);
	}

	async upsertComponents(
		components: Component[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.adapter.upsertComponents(components, options);
	}

	async patchComponent(
		componentId: UUID,
		ops: PatchOp[],
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.adapter.patchComponents([{ componentId, ops }], options);
	}

	async patchComponents(
		updates: Array<{ componentId: UUID; ops: PatchOp[] }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.adapter.patchComponents(updates, options);
	}

	async patchComponentField(
		componentId: UUID,
		op: PatchOp,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.adapter.patchComponents([{ componentId, ops: [op] }], options);
	}

	async getComponentsByType(
		type: string,
		agentId?: UUID,
		options?: { entityContext?: UUID },
	): Promise<Component[]> {
		// Wraps queryEntities and extracts components from entities
		const entities = await this.adapter.queryEntities({
			componentType: type,
			agentId: agentId ?? this.agentId,
			includeAllComponents: false, // Only return matched components
			...(options?.entityContext != null && {
				entityContext: options.entityContext,
			}),
		});

		// Flatten components from all entities
		const components: Component[] = [];
		for (const entity of entities) {
			if (entity.components) {
				components.push(...entity.components);
			}
		}
		return components;
	}

	async upsertMemory(
		memory: Memory,
		tableName: string,
		options?: { entityContext?: UUID },
	): Promise<void> {
		// Apply secret redaction (same as createMemory) to prevent plaintext secrets
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}
		return this.adapter.upsertMemories([{ memory, tableName }], options);
	}

	async upsertMemories(
		memories: Array<{ memory: Memory; tableName: string }>,
		options?: { entityContext?: UUID },
	): Promise<void> {
		return this.adapter.upsertMemories(memories, options);
	}

	// Batch relationship methods
	async createRelationships(
		relationships: Array<{
			sourceEntityId: UUID;
			targetEntityId: UUID;
			tags?: string[];
			metadata?: Metadata;
		}>,
	): Promise<UUID[]> {
		return this.adapter.createRelationships(relationships);
	}

	async getRelationshipsByIds(
		relationshipIds: UUID[],
	): Promise<Relationship[]> {
		return this.adapter.getRelationshipsByIds(relationshipIds);
	}

	async getRelationshipsByPairs(
		pairs: Array<{ sourceEntityId: UUID; targetEntityId: UUID }>,
	): Promise<(Relationship | null)[]> {
		return this.adapter.getRelationshipsByPairs(pairs);
	}

	async updateRelationships(relationships: Relationship[]): Promise<void> {
		return this.adapter.updateRelationships(relationships);
	}

	async deleteRelationships(relationshipIds: UUID[]): Promise<void> {
		return this.adapter.deleteRelationships(relationshipIds);
	}

	// Single-item relationship wrappers
	async createRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
		tags?: string[];
		metadata?: Metadata;
	}): Promise<boolean> {
		const ids = await this.adapter.createRelationships([params]);
		return ids.length > 0;
	}

	async getRelationship(params: {
		sourceEntityId: UUID;
		targetEntityId: UUID;
	}): Promise<Relationship | null> {
		// This one doesn't have a batch equivalent for the source+target query
		// It uses the getRelationship query method
		const results = await this.adapter.getRelationshipsByPairs([params]);
		return results[0] ?? null;
	}

	async updateRelationship(relationship: Relationship): Promise<void> {
		return this.adapter.updateRelationships([relationship]);
	}

	// ── Batch memory passthroughs ────────────────────────────────────────
	// These go straight to the adapter with no transformation.
	// WHY no redaction here: batch callers are responsible for their own
	// content. The single-item createMemory() wrapper below handles
	// redaction for the common case.
	async createMemories(
		memories: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
	): Promise<UUID[]> {
		return this.adapter.createMemories(memories);
	}

	async updateMemories(
		memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>,
	): Promise<void> {
		return this.adapter.updateMemories(memories);
	}

	async deleteMemories(memoryIds: UUID[]): Promise<void> {
		return this.adapter.deleteMemories(memoryIds);
	}

	// ── Single-item memory wrappers ────────────────────────────────────
	// These exist for caller convenience. getMemoryById and createMemory
	// are the most frequently called methods in the entire codebase.
	async getMemoryById(id: UUID): Promise<Memory | null> {
		const memories = await this.adapter.getMemoriesByIds([id]);
		return memories.length > 0 ? memories[0] : null;
	}

	// WHY createMemory is special: it performs secret redaction before
	// delegating to the adapter. This is the ONLY place where API keys,
	// tokens, and other secrets are scrubbed from memory content. Internal
	// runtime code deliberately calls this wrapper (not adapter.createMemories
	// directly) to ensure redaction always happens.
	async createMemory(
		memory: Memory,
		tableName: string,
		unique?: boolean,
	): Promise<UUID> {
		if (unique !== undefined) memory.unique = unique;

		// Redact any secrets from memory content before storing
		const secrets = this.getSecretsForRedaction();
		if (Object.keys(secrets).length > 0 && memory.content.text) {
			memory = {
				...memory,
				content: {
					...memory.content,
					text: redactWithSecrets(memory.content.text, {
						secrets,
						applyPatterns: true,
					}),
				},
			};
		}

		// Facts are structurally deduped at write time: when an equivalent row
		// (same normalized text + room + entity) already exists, skip the insert
		// and hand back the existing id. The adapter cannot do this — its
		// similarity check needs an embedding (absent inline on fact writes) and
		// is bypassed whenever callers pass `unique` — so without this guard the
		// same claim lands as multiple rows (see runtime/fact-write-dedupe.ts).
		// A dedupe hit may still carry new information: stronger metadata on the
		// incoming occurrence (higher confidence, an explicit kind, a fresher
		// validity timestamp) upgrades the kept row instead of being dropped.
		if (tableName === "facts") {
			const equivalent = await findEquivalentFact(this, memory);
			if (equivalent?.id) {
				const upgraded = mergeStrongerFactMetadata(equivalent, memory);
				if (upgraded) {
					await this.updateMemory({ id: equivalent.id, metadata: upgraded });
				}
				return equivalent.id;
			}
		}

		const ids = await this.adapter.createMemories([
			{ memory, tableName, unique },
		]);
		const memoryId = ids[0];
		await this.applyPipelineHooks(
			"after_memory_persisted",
			afterMemoryPersistedPipelineHookContext(memory, tableName, memoryId),
		);
		return memoryId;
	}

	async updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean> {
		await this.adapter.updateMemories([memory]);
		return true; // Successfully updated if no error thrown
	}

	async deleteMemory(memoryId: UUID): Promise<void> {
		return this.adapter.deleteMemories([memoryId]);
	}

	// ── Participant passthroughs & wrappers ──────────────────────────────
	async deleteParticipants(
		participants: Array<{ entityId: UUID; roomId: UUID }>,
	): Promise<boolean> {
		return this.adapter.deleteParticipants(participants);
	}

	async updateParticipants(
		participants: Array<{
			entityId: UUID;
			roomId: UUID;
			updates: Partial<Participant>;
		}>,
	): Promise<void> {
		return this.adapter.updateParticipants(participants);
	}

	async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
		return this.adapter.deleteParticipants([{ entityId, roomId }]);
	}

	// ── Room passthroughs & wrappers ────────────────────────────────────
	async updateRooms(rooms: Room[]): Promise<void> {
		return this.adapter.updateRooms(rooms);
	}

	async deleteRooms(roomIds: UUID[]): Promise<void> {
		return this.adapter.deleteRooms(roomIds);
	}

	// Single-item room wrappers
	async updateRoom(room: Room): Promise<void> {
		return this.adapter.updateRooms([room]);
	}

	async deleteRoom(roomId: UUID): Promise<void> {
		return this.adapter.deleteRooms([roomId]);
	}

	on(event: string, callback: (data: EventPayload) => void): void {
		if (!this.eventHandlers.has(event)) {
			this.eventHandlers.set(event, []);
		}
		const handlers = this.eventHandlers.get(event);
		if (handlers) {
			handlers.push(callback);
		}
	}
	off(event: string, callback: (data: EventPayload) => void): void {
		const handlers = this.eventHandlers.get(event);
		if (!handlers) {
			return;
		}
		const index = handlers.indexOf(callback);
		if (index !== -1) {
			handlers.splice(index, 1);
		}
	}
	emit(event: string, data: EventPayload): void {
		const handlers = this.eventHandlers.get(event);
		if (!handlers) {
			return;
		}
		for (const handler of handlers) {
			handler(data);
		}
	}
	async sendControlMessage(params: {
		roomId: UUID;
		action: "enable_input" | "disable_input";
		target?: string;
	}): Promise<void> {
		const { roomId, action, target } = params;
		const controlMessage: ControlMessage = {
			type: "control",
			payload: {
				action,
				target,
			},
			roomId,
		};
		await this.emitEvent("CONTROL_MESSAGE", {
			runtime: this,
			message: controlMessage,
			source: "agent",
		});

		this.logger.debug(
			{ src: "agent", agentId: this.agentId, action, channelId: roomId },
			"Control message sent",
		);
	}

	registerSearchCategory(registration: SearchCategoryRegistration): void {
		const normalized = normalizeSearchCategoryRegistration(registration);
		const key = getSearchCategoryKey(normalized.category);
		if (this.searchCategories.has(key)) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					searchCategory: normalized.category,
				},
				"Search category already registered, overwriting",
			);
		}
		this.searchCategories.set(key, normalized);
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				searchCategory: normalized.category,
			},
			"Search category registered",
		);
	}

	getSearchCategories(
		options: SearchCategoryEnumerationOptions = {},
	): SearchCategoryRegistration[] {
		const requestedContexts =
			options.contexts && options.contexts.length > 0
				? new Set(options.contexts)
				: null;
		return Array.from(this.searchCategories.values())
			.filter((registration) => {
				if (!options.includeDisabled && registration.enabled === false) {
					return false;
				}
				if (!requestedContexts) {
					return true;
				}
				if (!registration.contexts || registration.contexts.length === 0) {
					return true;
				}
				return registration.contexts.some((context) =>
					requestedContexts.has(context),
				);
			})
			.map(cloneSearchCategoryRegistration)
			.sort((a, b) => a.category.localeCompare(b.category));
	}

	getSearchCategory(
		category: string,
		options: SearchCategoryLookupOptions = {},
	): SearchCategoryRegistration {
		const key = getSearchCategoryKey(category);
		const registration = this.searchCategories.get(key);
		if (!registration) {
			throw new SearchCategoryRegistryError(
				"SEARCH_CATEGORY_NOT_FOUND",
				category,
				`No search category registered for category: ${category}`,
			);
		}
		if (!options.includeDisabled && registration.enabled === false) {
			throw new SearchCategoryRegistryError(
				"SEARCH_CATEGORY_DISABLED",
				registration.category,
				registration.disabledReason
					? `Search category disabled: ${registration.category} (${registration.disabledReason})`
					: `Search category disabled: ${registration.category}`,
			);
		}
		return cloneSearchCategoryRegistration(registration);
	}

	registerSendHandler(source: string, handler: SendHandlerFunction): void {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) {
			throw new Error("Send handler registration requires a source");
		}
		const routeKey = connectorRouteKey(normalized);
		if (this.sendHandlers.has(routeKey)) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: normalized,
				},
				"Send handler already registered, overwriting",
			);
		}
		this.sendHandlers.set(routeKey, handler);
		this.messageConnectors.set(routeKey, normalizeMessageConnector(normalized));
		this.logger.debug(
			{
				src: "agent",
				agentId: this.agentId,
				handlerSource: normalized,
			},
			"Send handler registered",
		);
	}

	registerMessageConnector(registration: MessageConnectorRegistration): void {
		const source =
			typeof registration.source === "string" ? registration.source.trim() : "";
		if (!source) {
			throw new Error("Message connector registration requires a source");
		}
		const accountId =
			normalizeConnectorAccountId(registration.accountId) ??
			normalizeConnectorAccountId(registration.account?.accountId);
		const routeKey = connectorRouteKey(source, accountId);
		if (
			this.messageConnectors.has(routeKey) ||
			this.sendHandlers.has(routeKey)
		) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: source,
					accountId,
				},
				"Message connector already registered, overwriting",
			);
		}

		if (registration.sendHandler) {
			this.sendHandlers.set(routeKey, registration.sendHandler);
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: source,
					accountId,
				},
				"Send handler registered",
			);
		}
		this.messageConnectors.set(
			routeKey,
			normalizeMessageConnector(source, {
				...registration,
				accountId,
			}),
		);
	}

	unregisterMessageConnector(source: string, accountId?: string): boolean {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) return false;
		const normalizedAccountId = normalizeConnectorAccountId(accountId);
		let removedConnector = false;
		let removedHandler = false;
		if (normalizedAccountId) {
			const routeKey = connectorRouteKey(normalized, normalizedAccountId);
			removedConnector = this.messageConnectors.delete(routeKey);
			removedHandler = this.sendHandlers.delete(routeKey);
		} else {
			for (const [routeKey, connector] of this.messageConnectors) {
				if (connector.source === normalized) {
					removedConnector =
						this.messageConnectors.delete(routeKey) || removedConnector;
				}
			}
			for (const routeKey of Array.from(this.sendHandlers.keys())) {
				if (connectorKeySource(routeKey) === normalized) {
					removedHandler = this.sendHandlers.delete(routeKey) || removedHandler;
				}
			}
		}
		if (removedConnector || removedHandler) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: normalized,
					accountId: normalizedAccountId,
				},
				"Message connector unregistered",
			);
		}
		return removedConnector || removedHandler;
	}

	getMessageConnectors(): MessageConnector[] {
		return Array.from(this.messageConnectors.values())
			.map(cloneMessageConnector)
			.sort(
				(a, b) =>
					a.source.localeCompare(b.source) ||
					(a.accountId ?? "").localeCompare(b.accountId ?? ""),
			);
	}

	registerPostConnector(registration: PostConnectorRegistration): void {
		const source =
			typeof registration.source === "string" ? registration.source.trim() : "";
		if (!source) {
			throw new Error("Post connector registration requires a source");
		}
		const accountId =
			normalizeConnectorAccountId(registration.accountId) ??
			normalizeConnectorAccountId(registration.account?.accountId);
		const routeKey = connectorRouteKey(source, accountId);
		if (this.postConnectors.has(routeKey)) {
			this.logger.warn(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: source,
					accountId,
				},
				"Post connector already registered, overwriting",
			);
		}
		this.postConnectors.set(
			routeKey,
			normalizePostConnector(source, {
				...registration,
				accountId,
			}),
		);
		this.logger.debug(
			{ src: "agent", agentId: this.agentId, handlerSource: source, accountId },
			"Post connector registered",
		);
	}

	unregisterPostConnector(source: string, accountId?: string): boolean {
		const normalized = typeof source === "string" ? source.trim() : "";
		if (!normalized) return false;
		const normalizedAccountId = normalizeConnectorAccountId(accountId);
		let removed = false;
		if (normalizedAccountId) {
			removed = this.postConnectors.delete(
				connectorRouteKey(normalized, normalizedAccountId),
			);
		} else {
			for (const [routeKey, connector] of this.postConnectors) {
				if (connector.source === normalized) {
					removed = this.postConnectors.delete(routeKey) || removed;
				}
			}
		}
		if (removed) {
			this.logger.debug(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: normalized,
					accountId: normalizedAccountId,
				},
				"Post connector unregistered",
			);
		}
		return removed;
	}

	getPostConnectors(): PostConnector[] {
		return Array.from(this.postConnectors.values())
			.map(clonePostConnector)
			.sort(
				(a, b) =>
					a.source.localeCompare(b.source) ||
					(a.accountId ?? "").localeCompare(b.accountId ?? ""),
			);
	}

	// NOTE: The owner-binding send gate (the "act as the user" guard) is enforced
	// at the MESSAGE action layer (ensureSendAccountAllowed in
	// features/advanced-capabilities/actions/message.ts), NOT here. This is the
	// low-level transport for every send path; direct callers that route through
	// an owner-bound account must apply their own gate before calling this.
	async sendMessageToTarget(
		target: TargetInfo,
		content: Content,
	): Promise<Memory | undefined> {
		const source =
			typeof target.source === "string" ? target.source.trim() : "";
		const accountId = normalizeConnectorAccountId(target.accountId);
		const handler =
			this.sendHandlers.get(connectorRouteKey(source, accountId)) ??
			this.sendHandlers.get(connectorRouteKey(source));
		if (!handler) {
			const errorMsg = accountId
				? `No send handler registered for source: ${source} accountId: ${accountId}`
				: `No send handler registered for source: ${source}`;
			this.logger.error(
				{
					src: "agent",
					agentId: this.agentId,
					handlerSource: source,
					accountId,
				},
				"Send handler not found",
			);
			throw new Error(errorMsg);
		}
		// Humanness voice gate (#14873): this is the connector-transport chokepoint
		// for every agent-initiated outbound message (scheduled dispatches,
		// escalations, task-agent routing, raw error strings). Rephrase the literal
		// into the agent's own voice unless it is already model-voiced
		// (`content.agentVoiced`); the gate fails open, so a rephrase outage
		// delivers the original text rather than blocking the send.
		const voicedContent = await ensureAgentVoice(this, content, { source });
		const result = await handler(this, target, voicedContent);
		return result as Memory | undefined;
	}

	private resolveMessageConnector(target: TargetInfo): {
		connector: MessageConnector;
		source: string;
		accountId: string | undefined;
	} {
		const source =
			typeof target.source === "string" ? target.source.trim() : "";
		const accountId = normalizeConnectorAccountId(target.accountId);
		const connector =
			this.messageConnectors.get(connectorRouteKey(source, accountId)) ??
			this.messageConnectors.get(connectorRouteKey(source));
		if (!connector) {
			throw new Error(
				accountId
					? `No message connector registered for source: ${source} accountId: ${accountId}`
					: `No message connector registered for source: ${source}`,
			);
		}
		return { connector, source, accountId };
	}

	private requireConnectorHook<K extends keyof MessageConnector>(
		target: TargetInfo,
		hook: K,
		capability: string,
	): MessageConnector {
		const { connector, source, accountId } =
			this.resolveMessageConnector(target);
		if (!connector[hook]) {
			const detail = accountId
				? `source: ${source} accountId: ${accountId}`
				: `source: ${source}`;
			throw new Error(`Connector does not support ${capability} (${detail})`);
		}
		return connector;
	}

	async editMessageOnTarget(
		target: TargetInfo,
		messageId: string,
		content: Content,
	): Promise<Memory | undefined> {
		const connector = this.requireConnectorHook(
			target,
			"editHandler",
			"edit_message",
		);
		const handler = connector.editHandler;
		if (!handler) {
			throw new Error("Connector does not support edit_message");
		}
		return (await handler(this, { target, messageId, content })) ?? undefined;
	}

	async sendTypingOnTarget(target: TargetInfo): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"typingHandler",
			"typing_indicator",
		);
		await connector.typingHandler?.(this, { target });
	}

	async stopTypingOnTarget(target: TargetInfo): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"stopTypingHandler",
			"typing_indicator",
		);
		await connector.stopTypingHandler?.(this, { target });
	}

	async createThreadOnTarget(
		target: TargetInfo,
		params: Omit<MessageConnectorCreateThreadParams, "target"> = {},
	): Promise<ThreadHandle> {
		const connector = this.requireConnectorHook(
			target,
			"createThreadHandler",
			"create_thread",
		);
		const handler = connector.createThreadHandler;
		if (!handler) {
			throw new Error("Connector does not support create_thread");
		}
		return handler(this, { target, ...params });
	}

	async postToThreadOnTarget(
		target: TargetInfo,
		thread: ThreadHandle,
		content: Content,
		identity?: ConnectorPostIdentity,
	): Promise<Memory | undefined> {
		const connector = this.requireConnectorHook(
			target,
			"postToThreadHandler",
			"post_to_thread",
		);
		return connector.postToThreadHandler?.(this, {
			target,
			thread,
			content,
			identity,
		});
	}

	async addReactionOnTarget(
		target: TargetInfo,
		messageId: string,
		emoji: string,
	): Promise<void> {
		const connector = this.requireConnectorHook(
			target,
			"reactHandler",
			"react_message",
		);
		await connector.reactHandler?.(this, { target, messageId, emoji });
	}

	async getMemoriesByWorldId(params: {
		worldId: UUID;
		limit?: number;
		tableName?: string;
	}): Promise<Memory[]> {
		return this.adapter.getMemoriesByWorldId(params);
	}
	async runMigrations(migrationsPaths?: string[]): Promise<void> {
		if (this.adapter.runMigrations) {
			await this.adapter.runMigrations(migrationsPaths);
		} else {
			this.logger.warn(
				{ src: "agent", agentId: this.agentId },
				"Database adapter does not support migrations",
			);
		}
	}

	async isReady(): Promise<boolean> {
		if (!this.adapter) {
			throw new Error("Database adapter not registered");
		}
		return this.adapter.isReady();
	}

	// Pairing Methods
	// ===============================

	async getPairingRequestsForChannel(
		channel: PairingChannel,
		agentId: UUID,
	): Promise<PairingRequest[]> {
		const results = await this.adapter.getPairingRequests([
			{ channel, agentId },
		]);
		return results[0]?.requests ?? [];
	}

	async getPairingRequests(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types/database").PairingRequestsResult> {
		return this.adapter.getPairingRequests(queries);
	}

	async getPairingAllowlistForChannel(
		channel: PairingChannel,
		agentId: UUID,
	): Promise<PairingAllowlistEntry[]> {
		const results = await this.adapter.getPairingAllowlists([
			{ channel, agentId },
		]);
		return results[0]?.entries ?? [];
	}

	async getPairingAllowlists(
		queries: Array<{ channel: PairingChannel; agentId: UUID }>,
	): Promise<import("./types/database").PairingAllowlistsResult> {
		return this.adapter.getPairingAllowlists(queries);
	}

	// Batch pairing methods
	async createPairingRequests(requests: PairingRequest[]): Promise<UUID[]> {
		return this.adapter.createPairingRequests(requests);
	}

	async updatePairingRequests(requests: PairingRequest[]): Promise<void> {
		return this.adapter.updatePairingRequests(requests);
	}

	async deletePairingRequests(ids: UUID[]): Promise<void> {
		return this.adapter.deletePairingRequests(ids);
	}

	async createPairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<UUID[]> {
		return this.adapter.createPairingAllowlistEntries(entries);
	}

	async updatePairingAllowlistEntries(
		entries: PairingAllowlistEntry[],
	): Promise<void> {
		return this.adapter.updatePairingAllowlistEntries(entries);
	}

	async deletePairingAllowlistEntries(ids: UUID[]): Promise<void> {
		return this.adapter.deletePairingAllowlistEntries(ids);
	}

	// Single-item pairing wrappers
	async createPairingRequest(request: PairingRequest): Promise<UUID> {
		const ids = await this.adapter.createPairingRequests([request]);
		return ids[0];
	}

	async updatePairingRequest(request: PairingRequest): Promise<void> {
		return this.adapter.updatePairingRequests([request]);
	}

	async deletePairingRequest(id: UUID): Promise<void> {
		return this.adapter.deletePairingRequests([id]);
	}

	async createPairingAllowlistEntry(
		entry: PairingAllowlistEntry,
	): Promise<UUID> {
		const ids = await this.adapter.createPairingAllowlistEntries([entry]);
		return ids[0];
	}

	async deletePairingAllowlistEntry(id: UUID): Promise<void> {
		return this.adapter.deletePairingAllowlistEntries([id]);
	}

	// Connector account storage passthroughs
	async listConnectorAccounts(
		params: ListConnectorAccountsParams = {},
	): Promise<ConnectorAccountRecord[]> {
		return this.adapter.listConnectorAccounts({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async getConnectorAccount(
		params: GetConnectorAccountParams,
	): Promise<ConnectorAccountRecord | null> {
		return this.adapter.getConnectorAccount({
			...params,
			agentId: params.id ? params.agentId : (params.agentId ?? this.agentId),
		});
	}

	async upsertConnectorAccount(
		params: UpsertConnectorAccountParams,
	): Promise<ConnectorAccountRecord> {
		return this.adapter.upsertConnectorAccount({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async deleteConnectorAccount(
		params: DeleteConnectorAccountParams,
	): Promise<boolean> {
		return this.adapter.deleteConnectorAccount({
			...params,
			agentId: params.id ? params.agentId : (params.agentId ?? this.agentId),
		});
	}

	async setConnectorAccountCredentialRef(
		params: SetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord> {
		return this.adapter.setConnectorAccountCredentialRef(params);
	}

	async getConnectorAccountCredentialRef(
		params: GetConnectorAccountCredentialRefParams,
	): Promise<ConnectorAccountCredentialRefRecord | null> {
		return this.adapter.getConnectorAccountCredentialRef(params);
	}

	async listConnectorAccountCredentialRefs(
		params: ListConnectorAccountCredentialRefsParams,
	): Promise<ConnectorAccountCredentialRefRecord[]> {
		return this.adapter.listConnectorAccountCredentialRefs(params);
	}

	async appendConnectorAccountAuditEvent(
		params: AppendConnectorAccountAuditEventParams,
	): Promise<ConnectorAccountAuditEventRecord> {
		return this.adapter.appendConnectorAccountAuditEvent({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async createOAuthFlowState(
		params: CreateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord> {
		return this.adapter.createOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async consumeOAuthFlowState(
		params: ConsumeOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.consumeOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async getOAuthFlowState(
		params: GetOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.getOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async updateOAuthFlowState(
		params: UpdateOAuthFlowStateParams,
	): Promise<OAuthFlowRecord | null> {
		return this.adapter.updateOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	async deleteOAuthFlowState(
		params: DeleteOAuthFlowStateParams,
	): Promise<boolean> {
		return this.adapter.deleteOAuthFlowState({
			...params,
			agentId: params.agentId ?? this.agentId,
		});
	}

	// ── Batch pass-throughs required by IDatabaseAdapter ────────────────

	async deleteRoomsByWorldIds(worldIds: UUID[]): Promise<void> {
		return this.adapter.deleteRoomsByWorldIds(worldIds);
	}

	async getRoomsByWorlds(
		worldIds: UUID[],
		limit?: number,
		offset?: number,
	): Promise<Room[]> {
		return this.adapter.getRoomsByWorlds(worldIds, limit, offset);
	}

	async installRemotePlugin(
		_plugin: Plugin,
		_options?: RemotePluginInstallOptions,
	): Promise<RemotePluginInstanceHandle> {
		throw new Error(
			"installRemotePlugin requires a host with RemotePluginBridge wiring (see @elizaos/agent).",
		);
	}
}

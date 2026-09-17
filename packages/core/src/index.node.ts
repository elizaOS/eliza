/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./access-context";
export * from "./access-control/artifact-disclosure";
export * from "./access-control/audience-disclosure";
export * from "./access-control/audience-egress";
export * from "./access-control/filter";
export * from "./access-control/provenance-envelope";
// Export all core modules
export * from "./account-pool-bridge";
export * from "./action-names";
export * from "./actions";
// The Stage-1 native-tool contract: model-provider plugins that serve
// RESPONSE_HANDLER structurally (native tool capture) key their detection on
// this name instead of duplicating the literal.
export { HANDLE_RESPONSE_TOOL_NAME } from "./actions/to-tool";
export * from "./boot-env";
export * from "./capabilities";
export * from "./capability-selection";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
// Export character utilities
export * from "./character-utils";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors/account-manager";
export * from "./connectors/connector-config";
export * from "./connectors/oauth-role";
export * from "./connectors/privacy";
export * from "./connectors.ts";
// Export additional constants not re-exported by character-utils
export {
	CANONICAL_SECRET_KEYS,
	type CanonicalSecretKey,
	CHANNEL_OPTIONAL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	LOCAL_MODEL_PROVIDERS,
	SECRET_KEY_ALIASES,
} from "./constants";

export * from "./contracts/computer-use";

export * from "./database";
export * from "./database/connector-json";
export * from "./database/document-list-query";
export * from "./database/world-metadata-cas";
export * from "./entities";
export * from "./env-utils";
export * from "./errors";
export {
	ElizaError,
	type ElizaErrorOptions,
	type ElizaErrorSeverity,
	isElizaError,
	type ReportedError,
	toElizaError,
} from "./errors";

// Export capabilities and plugin creation

// Cross-platform messaging triage (MESSAGE, MESSAGE, MESSAGE,
// MESSAGE, MESSAGE, adapters, SendPolicy, TriageService).
// Selective re-export — `MessageParticipant` collides with an unrelated type in
// `types/service-interfaces.ts`; consumers that need the triage-side participant type
// should import it from the package barrel.

// OAuth provider contract (the canonical provider identifiers the atomic OAuth
// actions accept). Exported so cloud-shared can enforce core ⊆ cloud-registry.

// Export generated action/provider/evaluator specs from centralized prompts
export * from "./identity-clusters";
export * from "./inference-timing";
export * from "./lifeops-passive-connectors";
export {
	addLogListener,
	type ChatInLogParams,
	type ChatOutLogParams,
	createLogger,
	customLevels,
	elizaLogger,
	type LogEntry,
	type Logger,
	type LoggerBindings,
	type LogListener,
	logChatIn,
	logChatOut,
	logger,
	logPrompt,
	logResponse,
	type PromptLogMetadata,
	type ResponseLogMetadata,
	recentLogs,
	removeLogListener,
} from "./logger";
// Export media utilities
export * from "./memory";
export * from "./messaging/interactions";
export * from "./messaging/manage-server-authorization";
export * from "./mobile-device-bridge-service";
export * from "./model-gateway";
export * from "./name-tokens";
// Export network utilities (SSRF protection, secure fetch)
export * from "./network";
export * from "./plugin";
// Export recent-errors provider (#12263)
export * from "./providers/recent-errors";
// Export skill eligibility provider
export * from "./providers/skill-eligibility";
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./recent-messages-state";
export * from "./roles";
export * from "./runtime";
export { actionGateRejection } from "./runtime/action-gate";
export { warnOnUnmatchedActionRolePolicyKeys } from "./runtime/action-role-policy";
export {
	__resetCandidateActionBackstopRulesForTests,
	type CandidateActionBackstopRule,
	getCandidateActionBackstopRules,
	registerCandidateActionBackstopRule,
} from "./runtime/candidate-action-backstop";
export * from "./runtime/cleanup-scope";
export * from "./runtime/content-access-manifest";
export * from "./runtime/content-projection-policy";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export {
	__resetDirectActionRoutingRulesForTests,
	type DirectActionRoutingRule,
	getDirectActionRoutingRules,
	registerDirectActionRoutingRule,
} from "./runtime/direct-action-routing";
export * from "./runtime/execute-planned-tool-call";
export {
	detectLocaleFromText,
	type ResolveOwnerLocaleOptions,
	resolveOwnerLocale,
	type SupportedLocale,
} from "./runtime/locale-detection";
export type {
	LocalizedActionExamplePair,
	LocalizedActionExampleResolver,
} from "./runtime/localized-examples-provider";
export {
	__resetLocalizedExamplesProviderForTests,
	getLocalizedExamplesProvider,
	type LocalizedExamplesProvider,
	type LocalizedExamplesProviderInput,
	registerLocalizedExamplesProvider,
} from "./runtime/localized-examples-provider";

// The planner's generic failed-tool apology is exported so relay/delivery
// layers (message service, orchestrator completion relays) can recognize it
// by identity and drop it as redundant next to an authoritative outcome.

export * from "./runtime/response-grammar";
export * from "./runtime/response-handler-evaluators";
export * from "./runtime/response-handler-field-evaluator";
export * from "./runtime/response-handler-field-registry";
export * from "./runtime/rlm";
export * from "./runtime/room-handler-queue";
export * from "./runtime/schema-compat";
export * from "./runtime/shortcut-registry";

export * from "./runtime/system-prompt";
export * from "./runtime/trace-correlation";
export * from "./runtime/trajectory-gate";
export * from "./runtime/trajectory-provider-attribution";
export * from "./runtime/trajectory-recorder";
export * from "./runtime/trajectory-usage-rollup";
export * from "./runtime/turn-controller";
export {
	type CallModelWithValidationOptions,
	type CallModelWithValidationResult,
	callModelWithValidation,
	DEFAULT_REMOTE_REROLL_BUDGET,
	getProviderForModelType,
	type ParseAndValidateResult,
	parseAndValidate,
	rerollBudgetCeilingFromSetting,
	SchemaValidationFailedError,
} from "./runtime/validated-model-call";
// Runtime composition (loadCharacters, createRuntimes, flattenRuntimeSettings, mergeSettingsInto) - node only
export * from "./runtime-composition";
// Export character schemas
export * from "./schemas/character";
export * from "./search";
export * from "./search/keyless-web-search";
// Export security utilities
export * from "./security";
export * from "./security/basic-email";
// Envelope unwrap for orchestration surfaces that forward a user message
// onward (deterministic follow-up sends must never embed the security banner
// in a child task — live 2026-08-21).
export { extractWrappedExternalContent } from "./security/external-content";
export { sanitizeOutboundText } from "./security/outbound-sanitize.ts";
export {
	isSensitiveKeyName,
	redactLogArgs,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
} from "./security/redact";
export * from "./security/secret-swap";
export * from "./sensitive-request-policy";
export * from "./sensitive-requests";
export * from "./services";
export * from "./services/agent-event-bridge";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/channel-topics";
export * from "./services/hook";
export * from "./services/notification";
export * from "./services/optimized-prompt";
export {
	type OptimizedPromptRuntimeLike,
	resolveOptimizedPromptForRuntime,
} from "./services/optimized-prompt-resolver";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/post-delivery-task-tracker";

export * from "./services/runtime-capability-service";
// TaskService is exported so hosts and tests can `instanceof`-check the
// runtime-registered instance; a relative src import would create a second
// class identity against the built package and always fail that check.
export {
	TaskService,
	type TaskServiceClock,
	type TaskServiceTimerHandle,
} from "./services/task";
export {
	getTaskSchedulerAdapter,
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	startTaskScheduler,
	stopTaskScheduler,
	unregisterTaskSchedulerRuntime,
} from "./services/task-scheduler";
export * from "./services/tool-policy";

export * from "./services/triggerScheduling";
// Export sessions utilities
export * from "./sessions";
export * from "./settings";
export * from "./streaming-context";
export * from "./target-sources";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export * from "./tunnel-service";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
// Export everything from types
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/notification";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
export type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
} from "./types/view-kind";
export {
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./types/view-kind";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml,
	parseToonKeyValue,
} from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/boolean";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	DestructiveConfirmationGateResult,
	RequireConfirmationArgs,
} from "./utils/confirmation";
// Unified two-phase confirmation helper for destructive actions.
export {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./utils/confirmation";
// Prompt description compression (parity with Python `compress_prompt_description`)
export * from "./utils/deterministic";
// Export browser-compatible utilities
export * from "./utils/environment";
export { getEnv } from "./utils/environment";
export * from "./utils/extraction-evidence";
export { formatError } from "./utils/format-error";
export * from "./utils/html-raw-text";
/** Single-lane local inference scheduling: interactive-over-background gate + device-class background budgets (#11914). */
export * from "./utils/inference-priority-gate";
export * from "./utils/inflection-term-keys";
export {
	assertModelOutputComplete,
	isModelOutputLimitFinishReason,
	isModelProviderError,
	modelProviderErrorDetail,
} from "./utils/model-errors";
// Export Node-specific utilities
export * from "./utils/project-memory-scope";
export * from "./utils/project-registry";
// Canonical env-var reader with legacy-alias back-compat
export * from "./utils/read-env";
// Blob-safe rendering of user/planner-supplied references in output
export * from "./utils/reference-echo";
// Canonical runtime-setting → env resolver (per-agent setting first, then env)
export * from "./utils/resolve-setting";
export * from "./utils/server-health";
// Eliza state-dir resolution (ELIZA_STATE_DIR → XDG state home)
export * from "./utils/state-dir";
// Export streaming utilities
export * from "./utils/streaming";
export { ResponseSkeletonStreamExtractor } from "./utils/streaming";
export * from "./utils/well-formed";
// User-chosen workspace folder persisted in <stateDir>/workspace-folder.json,
// shared between the Electrobun renderer (writes via desktop RPC) and the
// agent runtime (reads at boot to seed ELIZA_WORKSPACE_DIR for store builds).
export * from "./utils/workspace-folder-config";
// Export validation utilities
export * from "./validation";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;

export {
	hasAdminAccess,
	hasOwnerAccess,
	type SecurityDeps,
} from "./access-control/role-access.ts";
export { actionToJsonSchema } from "./actions/action-schema.ts";
export {
	pinnedDiscriminatorDescription,
	pinnedDiscriminatorForPromotedChild,
	promotedParentRoutingHint,
	promotedSubactionParent,
} from "./actions/promote-subactions.ts";
export {
	actionToTool,
	buildPlannerToolsFromActions,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	DISCOVER_TOOLS_NAME,
	SHOULD_RESPOND_SCHEMA_DESCRIPTION,
} from "./actions/to-tool.ts";

export { isInternalBridgeMessage } from "./messaging/automated-turns.ts";
export { actionGateFailure, canActionRun } from "./runtime/action-gate.ts";
export { settleActionHandler } from "./runtime/action-handler-settlement.ts";
export { isLocalProvider } from "./runtime/action-model-routing";
export { resolveActionRolePolicyRole } from "./runtime/action-role-policy.ts";
export { runWithActionRoutingContext } from "./runtime/action-routing-context.ts";
export { matchActionWildcardParts } from "./runtime/action-wildcard-glob.ts";
export { isCanonicalModelCapabilityDisabled } from "./runtime/canonical-model-capabilities.ts";
export {
	COMPLETION_CONTEXT_SCHEMA,
	COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
	collectCompletionContextSources,
	completionContextSources,
	parseCompletionContextSelection,
	referencePlannerQueryTokens,
	selectCompletionContext,
	withRequiredCompletionSourceIdentity,
} from "./runtime/completion-context.ts";
export {
	computePrefixHashes,
	hashStableJson,
	hashString,
	stableJsonStringify,
} from "./runtime/context-hash.ts";
export {
	appendContextEvent,
	createContextObject,
} from "./runtime/context-object.ts";
export {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "./runtime/context-renderer.ts";
export {
	bindEffectDelivery,
	effectDeliveryBindingIsValid,
	effectDeliveryBindingProvesApplication,
	getEffectDeliveryBinding,
	stripEffectDeliveryBinding,
} from "./runtime/effect-delivery.ts";
export {
	containsToolCallShapedMarkup,
	extractJsonObjects,
	parseJsonObject,
	parsePseudoTagToolInvocations,
	stringifyForDiagnostics,
	stringifyForModel,
	stripJsonStructuralJunkReply,
} from "./runtime/json-output.ts";
export {
	assertRepeatedFailureLimit,
	assertTrajectoryLimit,
	type ChainingLoopConfig,
	type FailureLike,
	mergeChainingLoopConfig,
	TrajectoryLimitExceeded,
} from "./runtime/limits.ts";
export { RUNTIME_DEBUG_LOG_ENABLED } from "./runtime/model-diagnostics.ts";
export { resolveProviderModelString } from "./runtime/model-dispatch/model-name.ts";
export {
	buildModelInputBudget,
	DEFAULT_INPUT_RESERVE_TOKENS,
	MODEL_WINDOW_RESERVE_FRACTION,
	withModelInputBudgetProviderOptions,
} from "./runtime/model-input-budget.ts";
export type {
	EvaluatorEffects,
	EvaluatorModelResult,
	EvaluatorOutput,
	EvaluatorRoute,
	EvaluatorRuntime,
	InferredSubactionDispatch,
	PlannerLoopParams,
	PlannerLoopResult,
	PlannerRuntime,
	PlannerStep,
	PlannerTerminalFailure,
	PlannerToolCall,
	PlannerToolResult,
	PlannerTrajectory,
	RunEvaluatorParams,
} from "./runtime/planner-types.ts";
export {
	buildProviderCachePlan,
	type CacheableSection,
	type ProviderCachePlan,
	type ProviderCachePlanArgs,
} from "./runtime/provider-cache-plan.ts";
export { projectDeferredProviders } from "./runtime/provider-context.ts";
export {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
	splitTranscriptList,
} from "./runtime/response-field-transcript.ts";
export { RunTerminalOwner } from "./runtime/run-terminal-owner";
export { withSemanticStageFanOut } from "./runtime/trajectory-semantic-stage-sink.ts";
export {
	looksLikeActionEnvelopeJson,
	looksLikeEvaluatorEnvelopeJson,
	looksLikeSpawnEnvelopeJson,
	sanitizeUserVisibleModelOutput,
	type UserVisibleModelOutput,
} from "./runtime/user-visible-model-output.ts";
export {
	AUTHORITY_KEYWORDS,
	containsObfuscatedKeyword,
	detectObfuscatedKeywordMatches,
	getKeywordPattern,
	INJECTION_KEYWORDS,
	INJECTION_PATTERNS,
	INTIMIDATION_KEYWORDS,
	normalizeForScan,
	reverseString,
	URGENCY_KEYWORDS,
} from "./security/injection-primitives.ts";
export { validateMcpServerConfig } from "./security/mcp-server-config.ts";
export {
	buildFailureReplyPrompt,
	classifyStructuredFailureCause,
	INSUFFICIENT_CREDITS_REPLY,
	isAuthError,
	isInsufficientCreditsError,
	isInsufficientCreditsMessage,
	isModelProviderFallbackError,
	isModelProviderRetryBudgetExhaustedError,
	isRateLimitError,
	MODEL_PROVIDER_RETRY_BUDGET_EXHAUSTED,
	type StructuredFailureCause,
	stripReasoningBlocks,
} from "./security/model-failure.ts";
export {
	createOutboundEnvelopeStreamLatch,
	guardOutboundEnvelopeAttachments,
	reportOutboundEnvelopeBlock,
} from "./security/outbound-envelope-guard.ts";
// Kernel contracts used by independently composed plugins.
export { projectCompleteToolArgsForModel } from "./security/tool-diagnostics.ts";
export {
	buildVoiceGatePrompt,
	type EnsureAgentVoiceOptions,
	ensureAgentVoice,
} from "./security/voice-gate.ts";
export { EmbeddingGenerationService } from "./services/embedding.ts";
export { PiiScrubService } from "./services/pii-scrub.ts";
export {
	createTrajectoryJsonBudget,
	type SanitizationState,
	sanitizeTrajectoryJsonObject,
	sanitizeTrajectoryJsonValue,
	sanitizeTrajectoryJsonValueInBudget,
	type TrajectoryJsonBudget,
} from "./services/trajectory-json.ts";
export {
	parseTrajectorySemanticStage,
	parseTrajectorySemanticStages,
	recordedStagesToSemanticStages,
	recordedStageToSemanticStage,
	TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION,
	type TrajectorySemanticStageRecord,
} from "./services/trajectory-semantic-stage.ts";
export {
	ELIZA_NATIVE_MODEL_BOUNDARIES,
	ELIZA_NATIVE_TRAJECTORY_FORMAT,
	type ElizaNativeModelBoundary,
	type ElizaNativeModelRequestRecord,
	type ElizaNativeModelResponseRecord,
	type ElizaNativeTrajectoryFormat,
	type ElizaNativeTrajectoryRow,
	type TrajectoryActionAttemptRecord,
	type TrajectoryCacheStatsRecord,
	type TrajectoryData,
	type TrajectoryDetailRecord,
	type TrajectoryExportFormat,
	type TrajectoryExportOptions,
	type TrajectoryExportResult,
	type TrajectoryFlattenedLlmCallRecord,
	type TrajectoryJsonShape,
	type TrajectoryListOptions,
	type TrajectoryListResult,
	type TrajectoryLlmCallRecord,
	type TrajectoryProviderAccessRecord,
	type TrajectoryScalar,
	type TrajectorySkillInvocationRecord,
	type TrajectorySkillInvocationTruncationMarker,
	type TrajectoryStatus,
	type TrajectoryStepId,
	type TrajectoryStepKind,
	type TrajectoryStepRecord,
	type TrajectorySummaryRecord,
	type TrajectoryUsageTotalsRecord,
} from "./services/trajectory-types.ts";
export type {
	ContextEvent,
	ContextObject,
	ContextObjectPromptSegment,
	ContextObjectTool,
} from "./types/context-object.ts";
export * from "./types/long-term-memory.ts";
export type {
	TokenUsageForCost,
	TrajectoryRuntimeLogger,
} from "./types/model-pricing";
export type {
	ActionAttempt,
	ARTTrajectory,
	ChatMessage as TrajectoryChatMessage,
	ContextObjectTrajectoryExport,
	ContextObjectTrajectoryVersion,
	EnvironmentState,
	LLMCall,
	ProviderAccess,
	RewardComponents,
	RewardRequest,
	RewardResponse,
	TrainingBatch,
	Trajectory,
	TrajectoryGroup,
	TrajectoryRecord,
	TrajectoryStep,
} from "./types/trajectory-export.ts";
export { CONTEXT_OBJECT_TRAJECTORY_VERSION } from "./types/trajectory-export.ts";
export {
	collectActionResultSizeWarnings,
	getActionResultActionName,
	trimActionResultForPromptState,
} from "./utils/action-results.ts";
export { hasActionContext } from "./utils/action-validation.ts";
export {
	readJsonFile,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "./utils/atomic-json.ts";
export { BatchProcessor, TaskDrain } from "./utils/batch-queue.ts";
export {
	CONTEXT_CAPABILITIES_STATE_KEY,
	getExplicitRoutingContexts,
	isPageScopedRoutingContext,
	routingContextsOverlap,
	shouldSurfaceContextCapabilities,
	withActiveRoutingContexts,
} from "./utils/context-routing.ts";
export { createHash } from "./utils/crypto-compat.ts";
export {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "./utils/expected-local-embedding-unavailability.ts";
export {
	getErrorMessage,
	isProviderContextOverflowError,
	isProviderContextOverflowFailure,
	isTransientModelError,
	PROVIDER_CONTEXT_OVERFLOW,
} from "./utils/model-errors.ts";
export {
	isPermanentQuotaError,
	providerRetryAfterMs,
} from "./utils/model-retry";
export { providerRateLimitRetryAt } from "./utils/model-retry.ts";
export {
	hasReasoningResidue,
	stripReasoningPrefixes,
} from "./utils/reasoning-tags.ts";
export { trimEndCharacters } from "./utils/string-boundaries.ts";
export {
	MAX_TEXT_NORMALIZE_EDGES,
	TEXT_NORMALIZE_UNBOUNDED,
	toMultilineText,
} from "./utils/text-normalize.ts";
export { createFirstSentenceStreamTracker } from "./utils/text-splitting.ts";
export {
	asRecord,
	asRecordOrUndefined,
	isObjectRecord,
	isPlainObject,
} from "./utils/type-guards.ts";
export { UnionFind } from "./utils/union-find.ts";

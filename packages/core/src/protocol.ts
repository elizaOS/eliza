/** Browser-safe public contracts and pure helpers. Internal modules import their defining files directly. */
export * from "./access-control/artifact-disclosure";
export * from "./access-control/audience-disclosure";
export * from "./access-control/audience-egress";
export * from "./access-control/filter";
export * from "./access-control/role-primitives.js";
export * from "./account-pool-bridge";
export * from "./action-names";
export { actionToJsonSchema } from "./actions/action-schema.ts";
export {
	composedPromotedSubactionDescription,
	pinnedDiscriminatorDescription,
	pinnedDiscriminatorForPromotedChild,
	promotedParentRoutingHint,
	promotedSubactionDescription,
	promotedSubactionParent,
} from "./actions/promote-subactions.ts";
export { validateToolArgs } from "./actions/validate-tool-args.ts";
export * from "./activity-plaintext.js";

export * from "./agent-backup-limits.js";
export {
	type AgentAutomationMode,
	type AgentStartupDiagnostics,
	type ChatImageAttachment,
	type ColumnInfo,
	type ConnectionTestResult,
	type CreateTriggerRequest,
	type DatabaseStatus,
	DELTA_STREAM_PROTOCOL,
	type DeltaStreamProtocol,
	type LogEntry as AgentLogEntry,
	type PluginParamDef,
	type QueryResult,
	type RuntimeOrderItem,
	type RuntimeServiceOrderItem,
	type SkillEntry,
	type StreamEventEnvelope,
	type StreamEventType as AgentStreamEventType,
	type TableInfo,
	type TriggerHealthSnapshot,
	type TriggerSummary,
	type TriggerTaskMetadata,
	type UpdateTriggerRequest,
} from "./api/agent-api-types.js";

export type {
	CommandsCatalogResponse,
	SerializedCommand,
	SerializedCommandArg,
	SerializedCommandSource,
} from "./api/command-transport-types.js";
export * from "./audio-redaction.js";
export * from "./audio-redaction-verify.js";
export * from "./awareness.js";
export * from "./canonical-json.js";
export * from "./capabilities/protocol.js";
export * from "./capabilities/remote-runner.js";
export * from "./capabilities/router.js";
export * from "./capability-catalog.js";
export * from "./capability-selection/retrieval";
export { default as channelPluginMap } from "./catalog/channel-plugin-map.json" with {
	type: "json",
};
export { loadRegistryFromRawEntries } from "./catalog/loader.js";
export { default as providerPluginMap } from "./catalog/provider-plugin-map.json" with {
	type: "json",
};
export * from "./catalog/runtime-kernel.js";
export { default as shortIdPluginMap } from "./catalog/short-id-plugin-map.json" with {
	type: "json",
};
export * from "./character";
export * from "./character-language.js";
export * from "./character-schema";
export * from "./character-utils";
export * from "./chat-upload-limits.js";
export * from "./connector-account-catalog.js";
export * from "./connectors/connector-config";
export * from "./connectors/privacy";
export * from "./connectors/target-sources";
export * from "./connectors.ts";
export * from "./contracts/apps.js";
export * from "./contracts/awareness.js";
export * from "./contracts/permissions.js";
export * from "./database";
export * from "./database/cache-cas";
export * from "./database/connector-json";
export * from "./database/document-list-query";
export * from "./database/world-metadata-cas";
export * from "./discord-dm-policy.js";
export * from "./embedding-vector-space";
export * from "./env-utils";
export * from "./error-classification.js";
export * from "./errors";

export * from "./events.js";
export type { ValidationKeywordLocale } from "./i18n/keyword-matching-core.js";
export * from "./i18n/language.js";
export * from "./i18n/recurrence-markers.js";
export * from "./inference-trace.js";
export * from "./markdown/chunk.js";
export * from "./markdown/code-spans.js";
export * from "./markdown/fences.js";
export * from "./markdown/frontmatter.js";
export {
	chunkMarkdownIR,
	type MarkdownIR,
	type MarkdownLinkSpan,
	type MarkdownParseOptions,
	type MarkdownStyle,
	type MarkdownStyleSpan,
	type MarkdownTableMode as MarkdownIRTableMode,
	markdownToIR,
	markdownToIRWithMeta,
} from "./markdown/ir.js";
export * from "./meeting-artifacts.js";
export * from "./meetings.js";
export * from "./memory";
export { isInternalBridgeMessage } from "./messaging/automated-turns.ts";
export * from "./messaging/interaction-dashboard-markers.js";
export {
	findInteractionRegions,
	hasInteractionBlocks,
	type InteractionRegion,
	MAX_FOLLOWUPS,
	MAX_FORM_FIELDS,
	MAX_TASK_TITLE_LEN,
	type ParsedInteractions,
	parseInteractionBlocks,
	stripUnclaimedInteractionMarkup,
} from "./messaging/interaction-parse.js";
export {
	createInteractiveTask,
	type InteractiveTask,
	sameTaskOwner,
	type TaskActionProposal,
	type TaskContext,
	type TaskObservation,
	type TaskOperation,
	type TaskOwner,
	type TaskTransition,
	transitionInteractiveTask,
	validateInteractiveTask,
} from "./messaging/interactive-task.js";

export {
	mergeTaskEventPage,
	mergeTaskEvents,
	type TaskEvent,
	type TaskEventPage,
	TaskEventReader,
	type TaskEventReaderOptions,
	type TaskEventReaderState,
	type TaskOperationStatus,
	type TaskStatus as TaskEventStatus,
	validateTaskEvent,
} from "./messaging/task-events.js";

export * from "./messaging/task-widgets.js";
export * from "./mobile-device-bridge-service";
export * from "./model-gateway";
export * from "./name-tokens";
export * from "./network/ssrf.js";
export type { BuildVariant } from "./platform/build-variant.js";
export * from "./platform/eliza-os.js";
export * from "./platform/is-native-server.js";
export type {
	NativeLibraryCandidate,
	NativeLibraryPolicyOptions,
} from "./platform/native-library-policy.js";
export * from "./recent-messages-state";
export * from "./retrieval.js";
export type { RolesConfig } from "./roles.js";
export * from "./runtime/action-wildcard-glob.ts";
export * from "./runtime/candidate-action-backstop";
export * from "./runtime/content-access-manifest";
export * from "./runtime/context-gates";
export {
	appendContextEvent,
	createContextObject,
} from "./runtime/context-object.ts";
export * from "./runtime/context-registry";
export {
	buildStageChatMessages,
	cachePrefixSegments,
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "./runtime/context-renderer.ts";
export * from "./runtime/direct-action-routing";
export * from "./runtime/effect-delivery.ts";
export * from "./runtime/historical-receipt-wire";
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
export * from "./runtime/locale-detection";
export * from "./runtime/localized-examples-provider";
export {
	buildModelInputBudget,
	DEFAULT_CONTEXT_WINDOW_TOKENS,
	DEFAULT_INPUT_RESERVE_TOKENS,
	estimateTokensFromChars,
	MODEL_WINDOW_RESERVE_FRACTION,
	type ModelInputBudget,
	withModelInputBudgetProviderOptions,
} from "./runtime/model-input-budget.ts";
export * from "./runtime/model-modality.ts";
export {
	isCanonicalModelCapabilityDisabled,
	resolveProviderModelString,
} from "./runtime/model-policy.js";
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
export * from "./runtime/prepared-model-request";
export {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
	splitTranscriptList,
} from "./runtime/response-field-transcript.ts";
export * from "./runtime/response-handler-evaluators";
export * from "./runtime/response-handler-field-evaluator";
export * from "./runtime/response-handler-field-registry";
export * from "./runtime/rlm";
export * from "./runtime/run-terminal-owner";
export * from "./runtime/system-prompt";
export * from "./runtime/trajectory-usage-rollup";
export {
	looksLikeActionEnvelopeJson,
	looksLikeEvaluatorEnvelopeJson,
	looksLikeSpawnEnvelopeJson,
	sanitizeUserVisibleModelOutput,
	type UserVisibleModelOutput,
} from "./runtime/user-visible-model-output.ts";
export * from "./security/augmented-request.js";
export * from "./security/basic-email";
export * from "./security/bind-host.js";
export * from "./security/entity-recognizer.js";
export * from "./security/external-content";
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
export * from "./security/log-redaction.js";
export * from "./security/outbound-envelope-guard.js";
export * from "./security/outbound-sanitize.ts";
export * from "./security/pii-context-pack.js";
export * from "./security/process-env-policy.js";
export * from "./security/redact";
export * from "./security/spawn-env-policy.js";
export {
	composeToolDiagnosticRedactor,
	projectCompleteToolArgsForModel,
	projectCompleteToolValueForModel,
	projectModelCallDiagnosticValue,
	projectProtectedModelCallValue,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	TOOL_DIAGNOSTIC_MASK,
	type ToolDiagnosticTextRedactor,
} from "./security/tool-diagnostics.js";

export * from "./security/untrusted-email-content.js";
export * from "./sensitive-request-dispatch";
export * from "./sensitive-request-policy";
export * from "./services";
export {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptRuntimeLike,
	type RuntimePromptResolver,
	resolveOptimizedPrompt,
	resolveOptimizedPromptForRuntime,
	trimDemonstrationInput,
} from "./services/optimized-prompt-resolver";
export * from "./services/pairing-integration";
export * from "./services/post-delivery-task-tracker";
export * from "./services/runtime-capability-service";
export * from "./services/trajectory-export.ts";
export * from "./services/trajectory-json.ts";
export * from "./services/trajectory-semantic-stage.ts";
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
export * from "./services/trigger-scheduling";
export * from "./sessions/provider.js";
export * from "./sessions/session-key.js";
export * from "./sessions/types.js";
export * from "./speaker-name-inference.js";
export * from "./spoken-text.js";
export * from "./transcripts.js";
export * from "./tunnel-service";
export * from "./types/access-context.js";
export * from "./types/action-failure.js";
export * from "./types/agent.js";
export * from "./types/agent-event";
export * from "./types/channel-config.js";
export * from "./types/chat-pre-handler.js";
export * from "./types/coding.js";
export * from "./types/commands.js";
export * from "./types/components.js";
export type {
	ConnectorAccountAccessGate,
	ConnectorAccountPolicy,
	ConnectorAccountStatus,
} from "./types/connector-account-policy.js";
export * from "./types/connector-setup.js";
export * from "./types/content.js";
export * from "./types/content-manifest.js";
export type {
	ContextEvent,
	ContextObject,
	ContextObjectPromptSegment,
	ContextObjectTool,
	ContextProviderEvent,
} from "./types/context-object.ts";
export * from "./types/contexts.js";
export * from "./types/database.js";
export * from "./types/documents.js";
export * from "./types/effects.js";
export * from "./types/environment.js";
export * from "./types/evaluator.js";
export * from "./types/events.js";
export * from "./types/hook.js";
export * from "./types/identity.js";
export * from "./types/interactions.js";
export * from "./types/long-term-memory.ts";
export * from "./types/membership.js";
export * from "./types/memory.js";
export * from "./types/memory-storage.js";
export * from "./types/message-service";
export * from "./types/message-source.js";
export * from "./types/messaging.js";
export * from "./types/model.js";
export * from "./types/model-pricing";
export * from "./types/notification.js";
export * from "./types/pairing.js";
export * from "./types/payment.js";
export {
	PENDING_USER_ACTION_WEIGHT,
	type PendingUserAction,
	type PendingUserActionKind,
	type PendingUserActionOption,
	type PendingUserActionResolution,
	type PendingUserActionResolutionTarget,
	type RequiresUserResponse,
} from "./types/pending-user-action.js";
export * from "./types/pipeline-hooks.js";
export * from "./types/plugin.js";
export * from "./types/plugin-manifest";
export * from "./types/plugin-store.js";
export * from "./types/primitives.js";

export * from "./types/prompt-optimization-hooks.js";
export * from "./types/prompt-optimization-score-card.js";
export * from "./types/prompt-optimization-trace.js";
export * from "./types/prompts.js";
export * from "./types/reminder-presentation";
export * from "./types/runtime.js";

export * from "./types/service.js";
export * from "./types/service-interfaces.js";
export * from "./types/settings.js";
export * from "./types/state.js";
export * from "./types/streaming.js";
export * from "./types/surface-manifest.js";

export * from "./types/swarm-coordinator.js";
export * from "./types/system-notice.js";
export * from "./types/task.js";
export * from "./types/tee.js";
export * from "./types/testing.js";
export {
	type ActionAttempt,
	type ARTTrajectory,
	type ChatMessage as TrajectoryChatMessage,
	CONTEXT_OBJECT_TRAJECTORY_VERSION,
	type ContextObjectTrajectoryExport,
	type ContextObjectTrajectoryVersion,
	type EnvironmentState,
	type LLMCall,
	type ProviderAccess,
	type RewardComponents,
	type RewardRequest,
	type RewardResponse,
	type TrainingBatch,
	type Trajectory,
	type TrajectoryGroup,
	type TrajectoryRecord,
	type TrajectoryStep,
} from "./types/trajectory-export.ts";

export * from "./types/trigger.js";
export * from "./types/view-kind.js";

export * from "./types/workspace-delta.js";
export {
	collectActionResultSizeWarnings,
	getActionResultActionName,
	trimActionResultForPromptState,
} from "./utils/action-results.ts";
export { hasActionContext } from "./utils/action-validation.ts";
export * from "./utils/assistant-text.js";
export type { BatchItemOutcome } from "./utils/batch-queue.js";
export * from "./utils/boolean";
export * from "./utils/channel-utils";
export * from "./utils/character-message-examples.js";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	DestructiveConfirmationGateResult,
	RequireConfirmationArgs,
} from "./utils/confirmation";
export {
	CONTEXT_CAPABILITIES_STATE_KEY,
	getExplicitRoutingContexts,
	isPageScopedRoutingContext,
	routingContextsOverlap,
	shouldSurfaceContextCapabilities,
	withActiveRoutingContexts,
} from "./utils/context-routing.ts";
export * from "./utils/deadline.js";
export * from "./utils/deterministic.js";
export * from "./utils/duration.js";
export * from "./utils/env.js";
export * from "./utils/errors.js";
export * from "./utils/example-names.js";
export * from "./utils/exec-safety.js";
export {
	isExpectedLocalEmbeddingUnavailability,
	modelProviderFailureDetails,
} from "./utils/expected-local-embedding-unavailability.ts";
export * from "./utils/extraction-evidence";
export type { SymlinkType } from "./utils/filesystem.js";
export * from "./utils/format-bytes.js";
export * from "./utils/format-error.js";
export * from "./utils/html-raw-text";
export * from "./utils/inflection-term-keys";
export * from "./utils/json5-model-output.js";
export { getLogPrefix } from "./utils/log-prefix.js";
export {
	assertModelOutputComplete,
	getErrorMessage,
	isModelOutputLimitFinishReason,
	isModelProviderError,
	isProviderContextOverflowError,
	isProviderContextOverflowFailure,
	isProviderSchemaRejection,
	isTransientModelError,
	modelProviderErrorDetail,
	PROVIDER_CONTEXT_OVERFLOW,
} from "./utils/model-errors";
export * from "./utils/model-retry";
export * from "./utils/number-parsing.js";
export * from "./utils/path-component.js";
export {
	getMacPermissionDeepLink,
	type OpenPermissionSettingsDeps,
	openPermissionSettings,
} from "./utils/permission-deep-links.js";
export {
	hasReasoningResidue,
	stripReasoningPrefixes,
} from "./utils/reasoning-tags.ts";
export * from "./utils/reference-echo";
export { sleepWithAbort } from "./utils/retry";
export * from "./utils/safe-diagnostic-error.js";
export * from "./utils/serialise.js";
export * from "./utils/streaming";
export * from "./utils/string-boundaries.js";
export {
	Semaphore,
	TaskDrain,
	type TaskDrainOptions,
} from "./utils/task-scheduling.js";
export {
	MAX_TEXT_NORMALIZE_EDGES,
	TEXT_NORMALIZE_UNBOUNDED,
	toMultilineText,
} from "./utils/text-normalize.ts";
export { createFirstSentenceStreamTracker } from "./utils/text-splitting.ts";
export * from "./utils/type-guards.ts";
export * from "./utils/unicode.js";
export * from "./utils/union-find.ts";
export { uuidFromString, validateUuid } from "./utils/uuid.js";
export * from "./utils/well-formed";
export * from "./validation/keywords";
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
} from "./validation/secret-catalog";
export * from "./validation/secrets";
export * from "./views/host-external-contract.js";
export * from "./views/shared-nav-targets.js";
export {
	IMMERSIVE_WALLPAPER_SURFACE,
	resolveSurfaceBackgroundPolicy,
	resolveSurfaceManifest,
	SURFACE_CAPABILITIES,
	SURFACE_ISOLATION_LEVELS,
	surfaceGrants,
} from "./views/surface-manifest.js";
export * from "./views/view-command-matcher.js";
export {
	collapseViewDeclarations,
	getViewModalities,
} from "./views/view-declarations.js";
export * from "./views/view-interact-protocol.js";
export {
	dedupeModalities,
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./views/view-kind.js";
export * from "./voice-cancellation-token.js";

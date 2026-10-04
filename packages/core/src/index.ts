/** Node runtime public entrypoint; browser consumers use the protocol barrel. */
export * from "./protocol.js";
/** Public Node runtime barrel. */

export * from "./access-context";
export * from "./access-control/provenance-envelope";
export * from "./actions";
// The Stage-1 native-tool contract: model-provider plugins that serve
// RESPONSE_HANDLER structurally (native tool capture) key their detection on
// this name instead of duplicating the literal.
export { HANDLE_RESPONSE_TOOL_NAME } from "./actions/to-tool";
export * from "./capability-selection/account-selection";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors/account-manager";
export * from "./connectors/oauth-role";
export * from "./entities";

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
// Shared media boundary: fetching, attachment decoding, MIME detection, and cache.
export * from "./media/attachments.js";
export * from "./media/fetch.js";
export * from "./media/image-description-cache.js";
export * from "./media/local-store.js";
export * from "./media/outbound.js";
export * from "./messaging/interactions";
export * from "./messaging/manage-server-authorization";
// Export network utilities (SSRF protection, secure fetch)
export {
	fetchWithSsrfGuard,
	type GuardedFetchOptions,
	type GuardedFetchResult,
	type PinnedLookupFetchLike,
	type PinnedLookupFetchParams,
} from "./network/fetch-guard.js";
export { nodeLookupFn, nodePinnedFetch } from "./network/node-pinned-fetch.js";
export {
	resolveFallbackOwnerEntityId,
	resolveOwnerEntityId,
} from "./owner-entity";
export * from "./plugin";
// Export recent-errors provider (#12263)
export * from "./providers/recent-errors";
// Export skill eligibility provider
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./roles";
export * from "./runtime";
export { actionGateRejection } from "./runtime/action-gate";
export { warnOnUnmatchedActionRolePolicyKeys } from "./runtime/action-role-policy";
export * from "./runtime/execute-planned-tool-call";

// The planner's generic failed-tool apology is exported so relay/delivery
// layers (message service, orchestrator completion relays) can recognize it
// by identity and drop it as redundant next to an authoritative outcome.

export {
	hasAdminAccess,
	hasOwnerAccess,
	type SecurityDeps,
} from "./access-control/role-access.ts";
export {
	bindTaskExtractionContext,
	readTaskExtractionContext,
} from "./actions/task-extraction-context";
export { HANDLE_RESPONSE_SCHEMA } from "./actions/to-tool.js";
export {
	actionToTool,
	buildPlannerToolsFromActions,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	DISCOVER_ACTIONS_NAME,
	DISCOVER_TOOLS_NAME,
	isDiscoveryActionName,
	SHOULD_RESPOND_SCHEMA_DESCRIPTION,
} from "./actions/to-tool.ts";
export {
	type AccountAuthKind,
	type AccountConfig,
	type AppEntry,
	type AppLaunch,
	accountConfigSchema,
	appEntrySchema,
	appLaunchSchema,
	type ConfigField,
	type ConnectorEntry,
	clearRegistryCacheForTests,
	configFieldSchema,
	connectorEntrySchema,
	getApps,
	getConnectors,
	getEntry,
	getEntryByNpmName,
	getPlugins,
	indexEntries,
	type LoadedRegistry,
	loadRegistry,
	mergeWithRuntime,
	normalizeConnectorAuth,
	type PluginEntry,
	pluginEntrySchema,
	type RegistryEntry,
	type RegistryKind,
	type RegistryRuntimeOverlay,
	type RegistryValidationError,
	type RegistryView,
	type RenderHints,
	type Resources,
	registerRegistryEntry,
	registryEntrySchema,
	registryRuntimeOverlaySchema,
	renderSchema,
	resourcesSchema,
	type SecondarySurface,
} from "./catalog/index.js";
export {
	conversationClientUserMemoryId,
	type DurableConversationChatMarker,
	normalizeChatIdempotencyKey,
	readDurableConversationChatMarker,
} from "./conversation-chat-marker.js";
export * from "./database/document-source-segments";
export {
	getValidationKeywordLocaleTerms,
	getValidationKeywordTerms,
} from "./i18n/keyword-matching.js";
export {
	collectKeywordTermMatches,
	collectPreparedKeywordTermMatches,
	findKeywordTermMatch,
	getValidationKeywordLocaleTerms as getCatalogValidationKeywordLocaleTerms,
	getValidationKeywordTerms as getCatalogValidationKeywordTerms,
	hasPreparedKeywordTermMatch,
	normalizeKeywordMatchText,
	type PreparedKeywordTerm,
	prepareKeywordTerms,
	splitKeywordDoc,
	textIncludesKeywordTerm,
	VALIDATION_KEYWORD_LOCALES,
} from "./i18n/keyword-matching-core.js";
export { VALIDATION_KEYWORD_DOCS } from "./i18n/keywords.js";
export {
	type CreateIntegrationSpanOptions,
	createIntegrationTelemetrySpan,
	defaultIntegrationSeverityPolicy,
	type IntegrationBoundary,
	type IntegrationLogger,
	type IntegrationObservabilityEvent,
	type IntegrationOutcome,
	type IntegrationSeverity,
	type IntegrationSeverityPolicy,
	type IntegrationSpanFailureArgs,
	type IntegrationSpanMeta,
	type IntegrationSpanSuccessArgs,
	type IntegrationTelemetrySpan,
} from "./integration-observability.ts";
export { __loggerTestHooks } from "./logger.js";
export * from "./media/mime.js";
export * from "./media/mime-sniffer.js";
export {
	_resetBuildVariantForTests,
	BUILD_VARIANTS,
	DEFAULT_BUILD_VARIANT,
	getBuildVariant,
	getDirectDownloadUrl,
	isDirectBuild,
	isStoreBuild,
} from "./platform/build-variant.js";
export {
	nativeLibraryPolicyInternalsForTest,
	resolveNativeLibraryCandidate,
} from "./platform/native-library-policy.js";
export {
	buildStoreVariantBlockedMessage,
	isLocalCodeExecutionAllowed,
} from "./platform/sandbox-policy.js";
export {
	actionGateFailure,
	actionGateNeedsCallerRoles,
	canActionRun,
	resolveActionCallerRoles,
	resolveActionGateFailure,
} from "./runtime/action-gate.ts";
export { settleActionHandler } from "./runtime/action-handler-settlement.ts";
export { isLocalProvider } from "./runtime/action-model-routing";
export { resolveActionRolePolicyRole } from "./runtime/action-role-policy.ts";
export { runWithActionRoutingContext } from "./runtime/action-routing-context.ts";
export {
	COMPLETION_CONTEXT_SCHEMA,
	COMPLETION_CONTEXT_SELECTION_INSTRUCTIONS,
	collectCompletionContextSources,
	completionContextSources,
	parseCompletionContextSelection,
	referencePlannerQueryTokens,
	selectCompletionContext,
	selectHistoricalNavigation,
	withRequiredCompletionSourceIdentity,
} from "./runtime/completion-context.ts";
export {
	computePrefixHashes,
	hashStableJson,
	hashString,
	stableJsonStringify,
} from "./runtime/context-hash.ts";
export * from "./runtime/message-content-segments";
export * from "./runtime/message-content-storage";
export { RUNTIME_DEBUG_LOG_ENABLED } from "./runtime/model-diagnostics.ts";
export {
	projectDeferredProviders,
	providerReviewSources,
	withProviderReviewSchema,
} from "./runtime/provider-context.ts";
export * from "./runtime/response-grammar";
export * from "./runtime/room-handler-queue";
export * from "./runtime/trace-correlation";
export * from "./runtime/trajectory-gate";
export * from "./runtime/trajectory-provider-attribution";
export * from "./runtime/trajectory-recorder";
export { withSemanticStageFanOut } from "./runtime/trajectory-semantic-stage-sink.ts";
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
export { flattenRuntimeSettings } from "./runtime-settings.ts";
export { mnemonicValid } from "./security/bip39-wordlist.js";
export * from "./security/confidential-inference.js";
export {
	type GuardedStreamOutput,
	GuardedStreamScanner,
	type GuardedStreamScannerOptions,
} from "./security/guarded-stream.js";
export {
	hardenIncomingUserMessage,
	type IncomingMessageSecurityMetadata,
	messageHasPromptInjectionFlag,
	registerCoreIncomingMessageSecurityHook,
	scrubIncomingMessageTextForStorage,
	unwrapUserMessageText,
	unwrapUserMessageTextForDetection,
} from "./security/incoming-message-security.js";
export {
	isLoopbackRemoteAddress,
	isRemoteAddressInCidrList,
	isTrustedLocalRequest,
	type LocalRequestTrustPolicy,
	proxyClientHeaderBlocksLocalTrust,
} from "./security/loopback-trust.js";
export { validateMcpServerConfig } from "./security/mcp-server-config.js";
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
	cardBrand,
	detectPii,
	ibanValid,
	ipv4Valid,
	luhnValid,
	PII_DETECTOR_BY_KIND,
	PII_DETECTORS,
	type PiiDetector,
	type PiiMatch,
	ssnValid,
	wifValid,
} from "./security/pii-detectors.js";
export {
	type AliasSubstitutionResult,
	type AssignClusterInput,
	assertValidSnapshot,
	CorpusPseudonymMap,
	type CorpusPseudonymMapOptions,
	type PseudonymClusterIdentity,
	type PseudonymClusterRecord,
	PseudonymMapIntegrityError,
	type PseudonymMapSnapshot,
} from "./security/pii-pseudonym-map.js";
export {
	EncryptedCachePseudonymMapStore,
	type EncryptedCachePseudonymMapStoreOptions,
	PII_PSEUDONYM_MAP_AAD,
	PII_PSEUDONYM_MAP_CACHE_KEY,
	type PseudonymMapStore,
	PseudonymMapStoreError,
} from "./security/pii-pseudonym-map-store.js";
export {
	collectPiiPromptText,
	DEFAULT_PSEUDONYM_BLOCKLIST,
	isPiiPseudonymUnbounded,
	MAX_PII_PSEUDONYM_KEY_BYTES,
	MAX_PII_PSEUDONYM_WALK_BYTES,
	MAX_PII_PSEUDONYM_WALK_DEPTH,
	MAX_PII_PSEUDONYM_WALK_NODES,
	PII_PSEUDONYM_UNBOUNDED,
	PII_SWAP_DISABLED_KINDS_SETTING,
	PII_SWAP_ENABLED_SETTING,
	PII_SWAP_EXEMPT_VALUES_SETTING,
	type PseudonymEntry,
	PseudonymSession,
	type PseudonymSessionOptions,
	parsePiiSwapList,
} from "./security/pii-pseudonymizer.js";
export {
	getScrubMarker,
	hashScrubContent,
	isScrubDone,
	markScrubDone,
	PII_SCRUB_MARKER_PREFIX,
	type PiiScrubDoneMarker,
	type ScrubMarkerCache,
	scrubMarkerKey,
	scrubMarkerKeyForContent,
} from "./security/pii-scrub-markers.js";
export {
	assertValidScrubResult,
	PiiScrubFabricationError,
	partitionScrubCandidates,
	type ScrubCandidatePartition,
	type ScrubEscalationRequest,
	type ScrubEscalationResult,
	type ScrubResultAssertionOptions,
	scrubWithEscalation,
	type Tier0Span,
} from "./security/pii-scrub-seam.js";
export {
	isProcessingPolicyDenial,
	PROCESSING_POLICY_DENIED,
	type ProcessingActionEffect,
	type ProcessingDecision,
	type ProcessingDenialReason,
	type ProcessingModelAttempt,
	type ProcessingPolicy,
	ProcessingPolicyDeniedError,
	type ProcessingRequest,
	type ProcessingScope,
} from "./security/processing-policy.js";
export * from "./security/secret-swap";
export {
	parseSecretSwapExemptValues,
	SECRET_SWAP_ENABLED_SETTING,
	SECRET_SWAP_EXEMPT_VALUES_SETTING,
	type SecretSwapEntry,
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./security/secret-swap.js";
export {
	attestAuthenticatedApiDeliveryAudience,
	attestDeliveryAudienceFromCanonicalRoom,
	authorizeOwnerExclusiveDisclosure,
	beginTrustedDeliveryAudienceTurn,
	disclosureGateFailure,
	evaluateOwnerExclusiveDisclosure,
	getTrustedDeliveryAudience,
	INTERNAL_AGENT_TURN_DISCLOSURE_BASIS,
	markOwnerExclusiveDisclosureUsed,
	OWNER_EXCLUSIVE_DISCLOSURE_GATE,
	OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
	type OwnerExclusiveDisclosureBasis,
	type OwnerExclusiveDisclosureDecision,
	type OwnerExclusiveDisclosureDenial,
	ownerExclusiveDisclosureWasUsed,
	ownerExclusiveSuppressionNote,
	PRIVACY_DENIED_TEXT,
	recordOwnerExclusiveSuppression,
	registerRuntimeManagedInternalActor,
	renewExpiredTrustedDeliveryAudience,
	renewTrustedDeliveryAudience,
	revalidateOwnerExclusiveDisclosure,
	type TrustedApiPrincipal,
	type TrustedApiPrincipalRevalidator,
	type TrustedDeliveryAudience,
	type TrustedDeliveryAudienceKind,
	type TrustedDeliveryAudienceProvenance,
	type TrustedDeliveryAudienceRenewal,
	trustedDeliveryAudienceCacheKey,
	trustedDeliveryAudienceIsBoundToRuntime,
} from "./security/trusted-delivery-audience.js";
export {
	buildVoiceGatePrompt,
	type EnsureAgentVoiceOptions,
	ensureAgentVoice,
} from "./security/voice-gate.ts";
export * from "./services/agent-event-bridge";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/channel-topics";
export { EmbeddingGenerationService } from "./services/embedding.ts";
export * from "./services/hook";
export * from "./services/notification";
export * from "./services/pairing";
export { PiiScrubService } from "./services/pii-scrub.ts";
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
export * from "./settings";
export * from "./streaming-context";
export {
	createSharedTodoCutoverSnapshot,
	MAX_SHARED_TODO_CUTOVER_BYTES,
	MAX_SHARED_TODO_CUTOVER_COUNT,
	MAX_SHARED_TODO_CUTOVER_MUTATION_COUNT,
	parseSharedTodoCutoverSnapshot,
	SHARED_TODO_CUTOVER_VERSION,
	SHARED_TODO_MUTATION_OPERATIONS,
	SHARED_TODO_MUTATION_WIRE_VERSION,
	SHARED_TODO_STATUSES,
	type SharedTodoCutoverRecord,
	type SharedTodoCutoverSnapshot,
	type SharedTodoMutationCutoverRecord,
	type SharedTodoMutationOperation,
	type SharedTodoStatus,
	TODO_CUTOVER_PROVENANCE_KEY,
	TodoCutoverContractError,
	type TodoCutoverJsonValue,
} from "./todo-cutover.js";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export * from "./types/action-reply.js";
export * from "./types/provider-integrations.js";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export { addHeader, parseKeyValueXml, parseToonKeyValue } from "./utils";
export {
	readJsonFile,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "./utils/atomic-json.ts";
export { BatchProcessor } from "./utils/batch-queue/batch-processor.js";
export {
	BatchQueue,
	type BatchQueueOptions,
	type DrainStats,
} from "./utils/batch-queue/index.js";
export {
	PriorityQueue,
	type PriorityQueueOptions,
	type PriorityQueueStats,
	type QueuePriority,
} from "./utils/batch-queue/priority-queue.js";
export * from "./utils/buffer";
// Unified two-phase confirmation helper for destructive actions.
export {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	isAffirmativeConfirmationReply,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./utils/confirmation";
export { createHash } from "./utils/crypto-compat.ts";
export {
	resolveElizaPackageRoot,
	resolveElizaPackageRootSync,
} from "./utils/eliza-root.js";
export {
	isEnvDisabled,
	isExactTrueEnvFlag,
	normalizeEnvValue,
	normalizeEnvValueOrNull,
} from "./utils/env.js";
export * from "./utils/environment";
export { getEnv } from "./utils/environment";
export {
	copy,
	ensureDir,
	ensureSymlink,
	pathExists,
	readdir,
	readFile,
	readJson,
	remove,
	rmdir,
	stat,
	unlink,
	writeJson,
} from "./utils/filesystem.js";
export * from "./utils/inference-priority-gate";
export { getLogPrefix } from "./utils/log-prefix.js";
export {
	getMacPermissionDeepLink,
	openPermissionSettings,
} from "./utils/permission-deep-links.js";
// Export Node-specific utilities
export * from "./utils/project-memory-scope";
export * from "./utils/read-env";
export * from "./utils/resolve-setting";
// Eliza state-dir resolution (ELIZA_STATE_DIR → XDG state home)
export * from "./utils/state-dir";
export {
	isTtsDebugEnabled,
	ttsDebug,
	ttsDebugTextPreview,
} from "./utils/tts-debug.js";

/** Node runtime public entrypoint; browser consumers use the protocol barrel. */

export * from "./access-context";
export * from "./access-control/provenance-envelope";
export * from "./actions";
export {
  bindTaskExtractionContext,
  readTaskExtractionContext,
  readTaskExtractionRequestIntents,
} from "./actions/task-extraction-context";
export {
  actionToTool,
  buildPlannerToolsFromActions,
  buildPlannerToolsFromTieredActions,
  CORE_PLANNER_TERMINALS,
  createHandleResponseTool,
  DISCOVER_ACTIONS_NAME,
  DISCOVER_TOOLS_NAME,
  HANDLE_RESPONSE_SCHEMA,
  HANDLE_RESPONSE_TOOL,
  HANDLE_RESPONSE_TOOL_NAME,
  isDiscoveryActionName,
  SHOULD_RESPOND_SCHEMA_DESCRIPTION,
} from "./actions/to-tool.ts";
export * from "./capabilities/account-selection";
export {
  getApps,
  getConnectors,
  getEntry,
  getEntryByNpmName,
  getPlugins,
  indexEntries,
  type LoadedRegistry,
  mergeWithRuntime,
  normalizeConnectorAuth,
  type RegistryValidationError,
} from "./catalog/loader.js";
export {
  clearRegistryCacheForTests,
  loadRegistry,
  registerRegistryEntry,
} from "./catalog/registry.js";
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
  configFieldSchema,
  connectorEntrySchema,
  type PluginEntry,
  pluginEntrySchema,
  type RegistryEntry,
  type RegistryKind,
  type RegistryRuntimeOverlay,
  type RegistryView,
  type RenderHints,
  type Resources,
  registryEntrySchema,
  registryRuntimeOverlaySchema,
  renderSchema,
  resourcesSchema,
  type SecondarySurface,
} from "./catalog/schema.js";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors/account-manager";
export * from "./connectors/oauth-role";
export {
  conversationClientUserMemoryId,
  type DurableConversationChatMarker,
  normalizeChatIdempotencyKey,
  readDurableConversationChatMarker,
} from "./conversation-chat-marker.js";
export * from "./database/document-source-segments";
export * from "./entities";
export {
  collectKeywordTermMatches,
  collectPreparedKeywordTermMatches,
  findKeywordTermMatch,
  getCatalogValidationKeywordLocaleTerms,
  getCatalogValidationKeywordTerms,
  getValidationKeywordLocaleTerms,
  getValidationKeywordTerms,
  hasPreparedKeywordTermMatch,
  normalizeKeywordMatchText,
  type PreparedKeywordTerm,
  prepareKeywordTerms,
  splitKeywordDoc,
  textIncludesKeywordTerm,
} from "./i18n/keyword-matching.js";
export {
  VALIDATION_KEYWORD_DOCS,
  VALIDATION_KEYWORD_LOCALES,
} from "./i18n/keywords.js";
export * from "./identity-clusters";
export * from "./inference-timing";
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
export {
  __loggerTestHooks,
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
  RUNTIME_DEBUG_LOG_ENABLED,
  recentLogs,
  removeLogListener,
} from "./logger.js";

// Shared media boundary: fetching, attachment decoding, MIME detection, and cache.
export * from "./media/attachments.js";
export * from "./media/fetch.js";
export * from "./media/image-description-cache.js";
export * from "./media/local-store.js";
export * from "./media/mime.js";
export * from "./media/outbound.js";
export * from "./messaging/interaction-dashboard-markers";
export * from "./messaging/interaction-host";
export * from "./messaging/interaction-layout";
export * from "./messaging/interaction-parse";
export * from "./messaging/interaction-profile-catalog";
export * from "./messaging/interaction-profiles";
export * from "./messaging/interaction-serialize";
export * from "./messaging/interaction-sessions";
export * from "./messaging/manage-server-authorization";
// Export network utilities (SSRF protection, secure fetch)
export {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  type PinnedLookupFetchLike,
  type PinnedLookupFetchParams,
} from "./network/fetch-guard.js";
export {
  createValidatedLookup,
  nodeLookupFn,
  nodePinnedFetch,
} from "./network/node-pinned-fetch.js";
export {
  assertPublicHttpsEndpoint,
  assertPublicInternetAddress,
  BLOCKED_PUBLIC_ENDPOINT_DNS_SUFFIXES,
  isPublicInternetAddress,
} from "./network/public-endpoint";
export {
  resolveFallbackOwnerEntityId,
  resolveOwnerEntityId,
} from "./owner-entity";
export * from "./plugin";
export * from "./protocol.js";
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./roles";
export * from "./runtime";
export {
  actionGateFailure,
  actionGateNeedsCallerRoles,
  actionGateRejection,
  canActionRun,
  resolveActionCallerRoles,
  resolveActionGateFailure,
  withActionGatePolicy,
} from "./runtime/action-gate";
export { settleActionHandler } from "./runtime/action-handler-settlement.ts";
export { isLocalProvider } from "./runtime/action-model-routing";
export {
  resolveActionRolePolicyRole,
  warnOnUnmatchedActionRolePolicyKeys,
} from "./runtime/action-role-policy";
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
export * from "./runtime/execute-planned-tool-call";
export * from "./runtime/message-content-segments";
export * from "./runtime/message-content-storage";
export {
  projectDeferredProviders,
  providerReviewSources,
  withProviderReviewSchema,
} from "./runtime/provider-context.ts";
// Export recent-errors provider
export * from "./runtime/recent-errors-provider";
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
// Bounded owner capture shares the canonical credential redaction policy.
export { isSensitiveKeyName, redactSensitiveText } from "./security/redact";
export * from "./security/secret-swap";
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
export * from "./services/agent-event";
export * from "./services/agent-event-bridge";
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
  registerScheduledProcessTask,
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
export {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from "./utils/atomic-json.ts";
export {
  BatchProcessor,
  BatchQueue,
  type BatchQueueOptions,
  type DrainStats,
  PriorityQueue,
  type PriorityQueueOptions,
  type PriorityQueueStats,
  type QueuePriority,
} from "./utils/batch-queue.js";
export * from "./utils/buffer";
// Unified two-phase confirmation helper for destructive actions.
export {
  clearPendingConfirmation,
  gateDestructiveConfirmation,
  isAffirmativeConfirmationReply,
  llmConfirmedFlagIsAuthoritative,
  requireConfirmation,
} from "./utils/confirmation";
export {
  resolveActionContexts,
  resolveProviderContexts,
} from "./utils/context-catalog";
export {
  AVAILABLE_CONTEXTS_STATE_KEY,
  attachAvailableContexts,
  CONTEXT_ROUTING_METADATA_KEY,
  CONTEXT_ROUTING_STATE_KEY,
  type ContextRoutingDecision,
  deriveAvailableContexts,
  getActiveRoutingContexts,
  getActiveRoutingContextsForTurn,
  getContextRoutingFromMessage,
  getContextRoutingFromState,
  inferContextRoutingFromMessage,
  inferContextRoutingFromText,
  mergeContextRouting,
  parseContextList,
  parseContextRoutingMetadata,
  setContextRoutingMetadata,
  shouldIncludeByContext,
} from "./utils/context-routing";
export { createHash } from "./utils/crypto-compat.ts";
export { parseDurationMs } from "./utils/duration.ts";
export {
  isEnvDisabled,
  isExactTrueEnvFlag,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
} from "./utils/env.js";
export * from "./utils/environment";
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
  extractUserText,
  getUserMessageText,
  hasDocumentAugmentationEnvelope,
  normalizeUserMessageText,
  stripAugmentationForPersistence,
} from "./utils/message-text";
export {
  getMacPermissionDeepLink,
  openPermissionSettings,
} from "./utils/permission-deep-links.js";
// Export Node-specific utilities
export * from "./utils/project-memory-scope";
// Eliza state-dir resolution (ELIZA_STATE_DIR → XDG state home)
export * from "./utils/state-dir";
export { stringToUuid } from "./utils/string-to-uuid.js";
export {
  isSyntheticConversationArtifactMemory,
  isSyntheticConversationArtifactText,
} from "./utils/synthetic-conversation-artifact";
export { extractFirstSentence, hasFirstSentence } from "./utils/text-splitting";
export {
  isTtsDebugEnabled,
  ttsDebug,
  ttsDebugTextPreview,
} from "./utils/tts-debug.js";
export { validateUuid } from "./utils/uuid.js";

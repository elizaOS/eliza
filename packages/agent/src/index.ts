/**
 * Public barrel for `@elizaos/agent` — the surface that sibling
 * `@elizaos/plugin-*` packages and the app shell import. Re-exports the HTTP API,
 * runtime boot and plugin resolution, long-lived services (including the TEE
 * stack), config and character schemas, auth, security, triggers, providers, and
 * diagnostics. Cloud route handlers are lazy wrappers that dynamically import
 * `@elizaos/plugin-elizacloud`. Many re-exports are deliberately named rather
 * than `export *` to dodge duplicate-symbol (TS2308) collisions and to keep
 * heavy plugins lazy-loaded — read the inline notes before widening any of them.
 */
import type {
  AgentCloudBillingRouteHandler,
  AgentCloudCompatRouteHandler,
  AgentCloudRouteHandler,
} from "./api/cloud-route-contracts.ts";

export {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "@elizaos/core/api/http-helpers";
export interface CloudConfigLike {
  apiKey?: string | null;
  baseUrl?: string | null;
  [key: string]: unknown;
}
type CloudUrlValidator = (value: string) => Promise<string | null>;
type ElizaCloudRoutesModule = {
  handleCloudBillingRoute: AgentCloudBillingRouteHandler;
  handleCloudCompatRoute: AgentCloudCompatRouteHandler;
  handleCloudRoute: AgentCloudRouteHandler;
  validateCloudBaseUrl: CloudUrlValidator;
};
async function loadElizaCloudRoutes(): Promise<ElizaCloudRoutesModule> {
  return import(
    "@elizaos/plugin-elizacloud"
  ) as Promise<ElizaCloudRoutesModule>;
}
export const handleCloudBillingRoute: AgentCloudBillingRouteHandler = async (
  ...args
) => {
  const { handleCloudBillingRoute } = await loadElizaCloudRoutes();
  return handleCloudBillingRoute(...args);
};
export const handleCloudCompatRoute: AgentCloudCompatRouteHandler = async (
  ...args
) => {
  const { handleCloudCompatRoute } = await loadElizaCloudRoutes();
  return handleCloudCompatRoute(...args);
};
export const handleCloudRoute: AgentCloudRouteHandler = async (...args) => {
  const { handleCloudRoute } = await loadElizaCloudRoutes();
  return handleCloudRoute(...args);
};
export async function validateCloudBaseUrl(
  value: string,
): Promise<string | null> {
  const { validateCloudBaseUrl } = await loadElizaCloudRoutes();
  return validateCloudBaseUrl(value);
}
export * from "@elizaos/auth/auth";
export type {
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  ElizaConfig,
  RolesConfig,
} from "@elizaos/core";
// Config contract types are exported from core above; the host config module
// supplies its own runtime functions.
export {
  type AppUiExtensionConfig,
  type AwarenessContributor,
  type AwarenessInvalidationEvent,
  AwarenessRegistry,
  type CreateIntegrationSpanOptions,
  collectKeywordTermMatches,
  createIntegrationTelemetrySpan,
  DEFAULT_CACHE_TTL_MS,
  defaultIntegrationSeverityPolicy,
  hasRoleAccess,
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
  type IPermissionsRegistry,
  isCloudExecutionMode,
  type LocalExecutionMode,
  type Prober,
  type RegistryAppInfo,
  type RuntimeExecutionMode,
  type RuntimeExecutionModeSource,
  resolveFallbackOwnerEntityId,
  resolveLocalExecutionMode,
  resolveOwnerEntityId,
  resolveRuntimeExecutionMode,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
  shouldUseSandboxExecution,
  textIncludesKeywordTerm,
} from "@elizaos/core";
export { CONNECTOR_PLUGINS } from "@elizaos/core/config/plugin-auto-enable-engine";
export type { ReleaseChannel } from "@elizaos/core/contracts/config";
export {
  RESTART_EXIT_CODE,
  type RestartHandler,
  requestRestart,
  setRestartHandler,
} from "@elizaos/core/restart";
export {
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/core/utils/number-parsing";
export {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "@elizaos/plugin-elizacloud/cloud-config/base-url";
export {
  connectAccountAction,
  messageWantsAccountConnect,
  resolveRequestedProviders,
} from "./actions/connect-account.ts";
export {
  contactAction,
  registerEntitySearchCategory,
} from "./actions/contact.ts";
export {
  hasContextSignal,
  hasContextSignalSync,
  hasContextSignalSyncForKey,
  hasSelectedActionContext,
  hasSelectedContextOrSignalSync,
  messageText,
} from "./actions/context-signal.ts";
export {
  type ContextSignalKey,
  type ContextSignalStrength,
  getContextSignalTerms,
  type ResolvedContextSignalSpec,
  resolveContextSignalSpec,
} from "./actions/context-signal-lexicon.ts";
export {
  databaseAction,
  registerVectorSearchCategory,
} from "./actions/database.ts";
export { logsAction } from "./actions/logs.ts";
export {
  ambiguousMemoryUserFacingText,
  inferMemorySubaction,
  MAX_MEMORY_ACTION_RESULT_CHARS,
  MAX_MEMORY_PAGE_ITEMS,
  memoryAction,
  memoryUserFacingLine,
} from "./actions/memories.ts";
export { pageDelegateAction } from "./actions/page-action-groups.ts";
export { pluginAction } from "./actions/plugin.ts";
export { runtimeAction } from "./actions/runtime.ts";
export {
  hasLoadedTextProvider,
  normalizeCodingBackend,
  readBackendRouting,
  SETTINGS_OPS,
  type SettingsOp,
  settingsAction,
  trimToString,
} from "./actions/settings-actions.ts";
export {
  completeOutputBlock,
  normalizeTerminalOutput,
  resolveTerminalTransportTimeoutMs,
  terminalAction,
} from "./actions/terminal.ts";
export {
  impliedTriggerQuery,
  TRIGGER_OPS,
  triggerAction,
} from "./actions/trigger.ts";
export * from "./api/config-env.ts";
export { handleConnectorAccountRoutes } from "./api/connector-account-routes.ts";
export * from "./api/conversation-metadata.ts";
export * from "./api/index.ts";
export { setOwnerContact } from "./api/owner-contact-helpers.ts";
export {
  findPrimaryEnvKey,
  isBlockedEnvKey,
  readBundledPluginPackageMetadata,
} from "./api/plugin-discovery-helpers.ts";
export * from "./api/plugin-runtime-apply.ts";
export type { PluginParamInfo } from "./api/plugin-validation.ts";
export {
  applyCanonicalFirstRunConfig,
  applyFirstRunCredentialPersistence,
  clearPersistedFirstRunConfig,
} from "./api/provider-switch-config.ts";
export { RegistryService } from "./api/registry-service.ts";
// Runtime-mode contract (mode resolution, route-visibility gate, remote-mode
// forwarder). `api/server.ts` enforces it in its own dispatch; the app
// compat pipeline calls the same pre-dispatch hook so every host shares one
// gate.
export {
  handleRuntimeModePreDispatch,
  handleRuntimeModeRemoteForward,
} from "./api/runtime-mode/pre-dispatch.ts";
export {
  forwardRemoteCloudMutation,
  shouldForwardToRemoteTarget,
} from "./api/runtime-mode/remote-forwarder.ts";
export {
  applyRouteModeGuard,
  evaluateRouteModeGate,
  findRegisteredRouteModeRule,
  type ModeGateOutcome,
  type RouteModeRuntimeLike,
  type RuntimeRouteModeRule,
} from "./api/runtime-mode/route-mode-guard.ts";
export * from "./api/runtime-mode/runtime-mode.ts";
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  type captureEarlyLogs,
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  ensureApiTokenForBindHost,
  extractAuthToken,
  fetchWithTimeoutGuard,
  injectApiBaseIntoHtml,
  isAllowedHost,
  isAuthorized,
  isSafeResetStateDir,
  normalizeWsClientId,
  type PluginConfigMutationRejection,
  persistConversationRoomTitle,
  resolveCorsOrigin,
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
  resolvePluginConfigMutationRejections,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWalletExportRejection,
  resolveWebSocketUpgradeRejection,
  routeAutonomyTextToUser,
  startApiServer,
  streamResponseBodyWithByteLimit,
} from "./api/server.ts";
// `server-helpers.ts` exposes auth/conversation/wallet helpers that the
// canonical `server.ts` already re-exports for backwards compat. Re-exporting
// the entire file would clash with those re-exports, so only surface helpers
// that aren't visible through `server.ts`.
export {
  type DeletedConversationsStateFile,
  getAgentEventSvc,
  initializeOGCodeInState,
  persistDeletedConversationIdsToState,
  readDeletedConversationIdsFromState,
  readOGCodeFromState,
  requireCoreManager,
  requirePluginManager,
} from "./api/server-helpers.ts";
// Loopback-trust + token helpers. These come from the canonical
// `./api/server-helpers-auth.js` (the same module the live server uses), not a
// divergent copy. `isLoopbackBindHost`/`tokenMatches` live in `@elizaos/core`
// and are not re-surfaced here; the `PluginConfigMutationRejection` type is
// exported through `./api/server.js`.
export {
  getConfiguredApiToken,
  isCredentialedCorsOrigin,
  isTrustedLocalRequest,
} from "./api/server-helpers-auth.ts";
// `server-types.ts` is the canonical source for conversation/server type
// shapes. `server.ts` already re-exports the bulk of these (see line ~520
// over there); the additional exports below cover names that aren't already
// re-exported through `./api/server.js`.
export type {
  AgentAutomationMode,
  ChatAttachmentWithData,
  ConnectorRouteHandler,
  ConversationAutomationType,
  ConversationMetadata,
  ConversationScope,
  PluginEntry,
  PluginParamDef,
  StreamEventType,
  TradePermissionMode,
} from "./api/server-types.ts";
export {
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  TxService,
} from "./api/tx-service.ts";
export { getWalletAddresses, initStewardWalletCache } from "./api/wallet.ts";
export * from "./api/wallet-capability.ts";
export * from "./api/workbench-helpers.ts";
export { runBenchmark } from "./cli/benchmark.ts";
export * from "./config/character-schema.ts";
export * from "./config/config.ts";
export * from "./config/env-vars.ts";
export * from "./config/includes.ts";
export * from "./config/model-metadata.ts";
export * from "./config/owner-contacts.ts";
export * from "./config/paths.ts";
// Export host-owned plugin metadata helpers for transport consumers.
export {
  getPluginWidgets,
  type PluginWidgetDeclarationServer,
} from "./config/plugin-widgets.ts";
export * from "./config/schema.ts";
export * from "./config/telegram-custom-commands.ts";
export { type LoadHooksOptions, loadHooks } from "./hooks/loader.ts";
export { createHookEvent, triggerHook } from "./hooks/registry.ts";
export * from "./providers/workspace.ts";
export * from "./runtime/advanced-capabilities-config.ts";
export * from "./runtime/agent-event-service.ts";
export {
  type BootHookContributor,
  type BootHookDeclaration,
  drainBootHookContributors,
  getBootHookContributors,
  resolveBootHookContributors,
  runBootHooks,
} from "./runtime/boot-hooks.ts";
export {
  type AgentEnvironment,
  BOOT_PHASES,
  type BootContext,
  type BootHostMode,
  type BootPhaseName,
  type BootPhaseObserver,
  type BootPlan,
  type BootPolicy,
  captureAgentEnvironment,
  createBootContext,
  type ElizaBootResult,
  resolveBootPlan,
  resolveBootPolicy,
} from "./runtime/boot-pipeline.ts";
export * from "./runtime/core-plugins.ts";
export {
  type DevTrajectoryRecoveryPreparation,
  type DevTrajectoryRecoveryRegistration,
  type DevTrajectoryRecoveryTransport,
  prepareDevTrajectoryRecovery,
} from "./runtime/dev-trajectory-recovery.ts";
export * from "./runtime/dev-trajectory-recovery-protocol.ts";
export * from "./runtime/eliza.ts";
export * from "./runtime/eliza-plugin.ts";
export * from "./runtime/first-run-names.ts";
export { extractPlugin } from "./runtime/load-plugin-from-vfs.ts";
export {
  LOGS_RETENTION_PREFIX,
  LOGS_RETENTION_SERVICE,
  type LogsRetentionAdapter,
  LogsRetentionService,
  type LogsSweepResult,
  resolveLogsRetentionService,
} from "./runtime/logs-retention-service.ts";
export {
  planRetention,
  policyIsActive,
  type ResolvedRetentionConfig,
  type RetainableRow,
  type RetentionPlan,
  type RetentionPolicy,
  resolveRetentionConfig,
  resolveRetentionConfigWithPrefix,
} from "./runtime/memory-retention.ts";
export {
  MEMORY_RETENTION_SERVICE,
  MemoryRetentionService,
  RETENTION_PARTITIONS,
  type RetentionAdapter,
  resolveMemoryRetentionService,
  type SweepResult,
} from "./runtime/memory-retention-service.ts";
export {
  type ClassifyContext,
  classifyOperation,
  defaultClassifier,
} from "./runtime/operations/classifier.ts";
export {
  type ColdStrategyOptions,
  createColdStrategy,
} from "./runtime/operations/cold-strategy.ts";
export {
  getDefaultHealthChecker,
  HealthChecker,
} from "./runtime/operations/health.ts";
export {
  builtInHealthChecks,
  dbConnectionCheck,
  essentialServicesCheck,
  providerSmokeCheck,
  runtimeReadyCheck,
} from "./runtime/operations/health-checks.ts";
export {
  DefaultRuntimeOperationManager,
  type DefaultRuntimeOperationManagerOptions,
  type IntentClassifier,
} from "./runtime/operations/manager.ts";
export {
  createHotStrategy,
  type HotStrategyDeps,
} from "./runtime/operations/reload-hot.ts";
export {
  FilesystemRuntimeOperationRepository,
  getDefaultRepository,
} from "./runtime/operations/repository.ts";
export type {
  ConfigReloadIntent,
  HealthCheck,
  HealthCheckReport,
  HealthCheckResult,
  OperationError,
  OperationErrorCode,
  OperationIntent,
  OperationKind,
  OperationPhase,
  OperationStatus,
  PhaseName,
  PhaseStatus,
  PluginDisableIntent,
  PluginEnableIntent,
  ProviderSwitchIntent,
  ReloadContext,
  ReloadStrategy,
  ReloadTier,
  RestartIntent,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationManager,
  RuntimeOperationRepository,
  StartOperationOutcome,
  StartOperationRequest,
} from "./runtime/operations/types.ts";
export * from "./runtime/operations/vault-bridge.ts";
export * from "./runtime/plugin-collector.ts";
export * from "./runtime/plugin-lifecycle.ts";
export {
  type FailedPluginDetail,
  getLastFailedPluginDetails,
  getLastFailedPluginNames,
  resolvePlugins,
} from "./runtime/plugin-resolver.ts";
export * from "./runtime/plugin-types.ts";
export {
  type AgentProcessLifecycle,
  createAgentProcessLifecycle,
  installProcessSignalHandlers,
} from "./runtime/process-lifecycle.ts";
export * from "./runtime/release-plugin-policy.ts";
export { default as rolesPlugin } from "./runtime/roles/src/index.ts";
export { rolesProvider } from "./runtime/roles/src/provider.ts";
export {
  type BoundedWalkOptions,
  type BoundedWalkRejection,
  type BoundedWalkResult,
  boundedWalk,
  TOOL_OUTPUT_LIMITS,
} from "./runtime/tool-call-cache/bounded-walk.ts";
export {
  isCacheableToolOutput,
  ToolCallCache,
  type ToolCallCacheOptions,
} from "./runtime/tool-call-cache/cache.ts";
export {
  buildCacheKey,
  CACHE_KEY_LIMITS,
  type CacheKeyRejection,
  type CacheKeyResult,
  type CanonicalizeLimits,
  type CanonicalizeResult,
  canonicalizeJson,
  ToolCacheKeyBoundError,
  tryBuildCacheKey,
  tryCanonicalizeJson,
} from "./runtime/tool-call-cache/key.ts";
export {
  defaultPrivacyRedactor,
  isRedactionDegraded,
} from "./runtime/tool-call-cache/redact.ts";
export {
  CACHEABLE_TOOL_REGISTRY,
  isCacheable,
  resolveToolDescriptor,
} from "./runtime/tool-call-cache/registry.ts";
export type {
  CacheableToolDescriptor,
  PrivacyRedactor,
  ToolArgs,
  ToolCacheEntry,
  ToolOutput,
} from "./runtime/tool-call-cache/types.ts";
export * from "./runtime/trajectory-internals.ts";
export {
  computeBySource,
  extractInsightsFromResponse,
  extractRows,
  flushObservationBuffer,
  pushChatExchange,
  readOrchestratorTrajectoryContext,
  shouldEnableTrajectoryLoggingByDefault,
  shouldRunObservationExtraction,
} from "./runtime/trajectory-internals.ts";
export * from "./runtime/trajectory-query.ts";
export { loadPersistedTrajectoryRows } from "./runtime/trajectory-query.ts";
export {
  DEFAULT_GET_STEPS_LIMIT,
  getSteps,
  loadAllStepsForTrajectory,
  MAX_GET_STEPS_LIMIT,
  type TrajectoryStepsPage,
} from "./runtime/trajectory-steps-reader.ts";
export {
  clearAllSteps,
  deleteStepsForTrajectories,
  replaceStepsForTrajectory,
  upsertStep,
} from "./runtime/trajectory-steps-writer.ts";
export {
  annotateTrajectoryStep,
  clearPersistedTrajectoryRows,
  completeTrajectoryStepInDatabase,
  createDatabaseTrajectoryLogger,
  DatabaseTrajectoryLogger,
  deletePersistedTrajectoryRows,
  flushTrajectoryWrites,
  installDatabaseTrajectoryLogger,
  pruneOldTrajectories,
  startTrajectoryStepInDatabase,
} from "./runtime/trajectory-storage.ts";
export * from "./runtime/version.ts";
export {
  hasAdminAccess,
  hasOwnerAccess,
  hasPrivateAccess,
  isAgentSelf,
  type RequiredRole,
} from "./security/access.ts";
export {
  __resetAuditFeedForTests,
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  type AuditEntry,
  type AuditEventType,
  type AuditFeedQuery,
  type AuditFeedSubscriber,
  type AuditLogConfig,
  type AuditSeverity,
  getAuditFeedSize,
  queryAuditFeed,
  SandboxAuditLog,
  subscribeAuditFeed,
} from "./security/audit-log.ts";
export * from "./services/agent-backup.ts";
export {
  AGENT_BACKUP_V2_PGLITE_CAPTURE_LIMITS,
  type AgentBackupDatabaseComponent,
  type AgentBackupFileEntry,
  type AgentBackupFileEnvelope,
  type AgentBackupFileSet,
  type AgentBackupManifest,
  type AgentBackupPgliteDump,
  type AgentBackupPostgresDump,
  type AgentBackupPostgresTable,
  type AgentBackupStateData,
  type AgentBackupV2CaptureComponentSource,
  AgentBackupV2CaptureError,
  type AgentBackupV2CaptureRuntime,
  type AgentBackupV2CaptureSourceChunk,
  AgentSnapshotBudgetExceededError,
  type CreateAgentBackupV2CaptureOptions,
  createAgentBackupV2Capture,
  createAgentSnapshot,
  createDefaultAgentBackupV2CaptureSources,
  createLocalAgentBackup,
  fetchAgentScopedRowsBatched,
  type LocalAgentBackupMetadata,
  listLocalAgentBackups,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT,
  PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT_CODE,
  type PglitePhysicalPreflight,
  preflightPglitePhysicalDirectory,
  purgeAdmittedRetiredLocalAgentBackups,
  type RetiredLocalAgentBackup,
  resolveAgentBackupAvailableMemoryBytes,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
  reviewRetiredLocalAgentBackups,
  SnapshotBudget,
  type SnapshotReservation,
  type StreamAgentBackupV2CaptureOptions,
  sha256AgentBackupV2CaptureChunk,
  streamAgentBackupV2Capture,
  withReviewedRetiredLocalAgentBackups,
} from "./services/agent-backup.ts";
export * from "./services/agent-export.ts";
export {
  AGENT_EXPORT_CANONICALIZE_UNBOUNDED,
  AGENT_EXPORT_FAILED,
  type AgentExportComponentDigest,
  AgentExportError,
  type AgentExportManifest,
  type AgentExportOptions,
  type AgentExportPayload,
  buildExportManifest,
  canonicalize,
  collectReferencedMediaFileNames,
  digestCollection,
  type ExportSizeEstimate,
  estimateExportSize,
  exportAgent,
  type ImportResult,
  importAgent,
  MANIFEST_COLLECTIONS,
  MAX_AGENT_EXPORT_CANONICALIZE_DEPTH,
  MAX_AGENT_EXPORT_CANONICALIZE_NODES,
  type ManifestCollection,
  type ManifestMismatch,
  type ManifestVerification,
  restoreMedia,
  verifyExportManifest,
} from "./services/agent-export.ts";
export {
  gatePluginSessionForHostedApp,
  hasActiveAppRunForCanonicalName,
  isHostedAppActiveForAgentActions,
} from "./services/app-session-gate.ts";
export {
  AUDIO_REDACTION_RULESET_VERSION,
  AUDIO_REDACTION_SERVICE_TYPE,
  AudioRedactionService,
  assertAudioRedactionInputBudget,
  assertAudioRedactionWordBudget,
  selectAudioRedactionSentinels,
  type VerifiedAudioRedactionRequest,
  type VerifiedAudioRedactionResult,
} from "./services/audio-redaction-service.ts";
export {
  MAX_AUDIO_REDACTION_MATCH_CANDIDATES,
  MAX_AUDIO_REDACTION_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS,
  MAX_AUDIO_REDACTION_PII_SPAN_CHARS,
  MAX_AUDIO_REDACTION_PII_SPANS,
  MAX_AUDIO_REDACTION_WORD_CHARS,
  MAX_AUDIO_REDACTION_WORDS,
} from "./services/audio-redaction-word-budget.ts";
export {
  type AuditedDecision,
  type BrokerOptions,
  type BrokerSnapshot,
  CapabilityBroker,
  type CapabilityDecision,
  type CapabilityKind,
  type CapabilityOp,
  type CapabilityRequest,
  getCapabilityBroker,
} from "./services/capability-broker.ts";
export {
  EscalationService,
  type EscalationState,
  registerEscalationChannel,
} from "./services/escalation.ts";
export {
  type JsRuntimeBridge,
  type JsRuntimeEvaluateOptions,
  type JsRuntimeFactory,
  type JsRuntimeImportOptions,
  type JsRuntimeKind,
  type JsValue,
  registerJsRuntimeFactory,
  resolveJsRuntimeBridge,
} from "./services/js-runtime-bridge.ts";
export {
  MessageInteractionHostService,
  type MessageInteractionHostServiceOptions,
  resolveMessageInteractionHostService,
} from "./services/message-interaction-host.ts";
export {
  FileMessageInteractionSessionStore,
  type FileMessageInteractionSessionStoreOptions,
} from "./services/message-interaction-session-store.ts";
export {
  isOverlayAppPresenceActive,
  OVERLAY_APP_PRESENCE_TTL_MS,
  setOverlayAppPresence,
} from "./services/overlay-app-presence.ts";
export {
  PERMISSIONS_REGISTRY_SERVICE,
  PermissionRegistry,
  type PermissionRegistryOptions,
} from "./services/permissions-registry.ts";
export {
  createPluginCompiler,
  PluginCompiler,
  type PluginCompilerFormat,
  type PluginCompilerOptions,
  type PluginCompilerResult,
} from "./services/plugin-compiler.ts";
export * from "./services/plugin-installer";
export type {
  CoreManagerLike,
  CoreStatusLike,
  EjectResult,
  InstallProgressLike,
  PluginInstallOptionsLike,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  RegistryPluginAppMeta,
  RegistryPluginAppSessionFeature,
  RegistryPluginAppSessionInfo,
  RegistryPluginAppSessionMode,
  RegistryPluginInfo,
  RegistryPluginNpmInfo,
  RegistryPluginViewerInfo,
  RegistrySearchResult,
  RegistryVersionSupport,
  ReinjectResult,
  SyncResult,
} from "./services/plugin-manager-types.ts";
export {
  type InstalledPluginInfo,
  isCoreManagerLike,
  isPluginManagerLike,
  type RegistryPluginInfo as RegistryPluginManagerInfo,
  type RegistrySearchResult as RegistryPluginManagerSearchResult,
} from "./services/plugin-manager-types.ts";
export {
  addRegistryEndpoint,
  getAppInfo,
  getConfiguredEndpoints,
  getPluginInfo,
  getRegistryPlugins,
  isDefaultEndpoint,
  listApps,
  listNonAppPlugins,
  refreshRegistry,
  removeRegistryEndpoint,
  searchApps,
  searchNonAppPlugins,
  searchPlugins,
  toggleRegistryEndpoint,
} from "./services/registry-client.ts";
export { resolveAppHeroImage } from "./services/registry-client-queries.ts";
export type {
  RegistryAppMeta,
  RegistryAppViewerMeta,
  RegistryPluginInfo as RegistryClientPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult as RegistryClientSearchResult,
} from "./services/registry-client-types.ts";
export {
  type ClusterMemoriesQuery,
  type ClusterSearchQuery,
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
  type RelationshipsGraphEdge,
  type RelationshipsGraphQuery,
  type RelationshipsGraphService,
  type RelationshipsGraphSnapshot,
  type RelationshipsGraphStats,
  type RelationshipsPersonDetail,
  type RelationshipsPersonFact,
  type RelationshipsPersonSummary,
  resolveRelationshipsGraphService,
  searchMemoriesForCluster,
} from "./services/relationships-graph.ts";
export {
  type CloudCapabilitySandboxProvisionOptions,
  type CloudCapabilitySandboxProvisionResult,
  type ConnectCloudCapabilitySandboxOptions,
  type ConnectCloudCapabilitySandboxResult,
  cloudCapabilityEndpointProvider,
  connectCloudCapabilitySandbox,
  provisionCloudCapabilitySandbox,
  type WaitForCloudCapabilityEndpointAvailabilityOptions,
  waitForCloudCapabilityEndpointAvailability,
} from "./services/remote-capability-cloud-sandbox.ts";
export {
  buildRemoteCapabilityEndpointTrustPolicy as buildEndpointTrustPolicy,
  buildRemoteCapabilityEndpointTrustPolicy,
  type ConnectRemoteCapabilityEndpointProviderOptions,
  type ConnectRemoteCapabilityEndpointProviderResult,
  connectRemoteCapabilityEndpointProvider,
  type DirectRemoteCapabilityEndpointProviderOptions,
  directRemoteCapabilityEndpointProvider,
  installRemoteCapabilityEndpoint,
  normalizeEndpointTrustPolicyOptions,
  type ProvisionedRemoteCapabilityEndpoint,
  REMOTE_CAPABILITY_ENDPOINT_URL_INVALID,
  type RemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointProviderId,
  type RemoteCapabilityEndpointTrustPolicyOptions,
  type TeeRemoteCapabilityEndpointProviderOptions,
  teeRemoteCapabilityEndpointProvider,
} from "./services/remote-capability-endpoint-provider.ts";
export {
  createRemoteCapabilityFetchHandler,
  type RemoteCapabilityEndpointConfig,
  type RemoteCapabilityFetchHandlerOptions,
  type RemoteCapabilityRouterConfig,
  RemoteCapabilityRouterService,
  type RemoteCapabilityServer,
  resolveRemoteCapabilityRouterConfig,
} from "./services/remote-capability-router.ts";
export {
  desktopCompanionCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  type UrlRemoteCapabilityEndpointProviderDefaults,
  type UrlRemoteCapabilityEndpointProviderOptions,
  urlRemoteCapabilityEndpointProvider,
} from "./services/remote-capability-url-endpoint-providers.ts";
export {
  bootstrapRemoteCapabilityPlugins,
  createRemoteCapabilityPlugin,
  type RemotePluginAdapterOptions,
  type RemotePluginBootstrapOptions,
  type RemotePluginSyncResult,
  type RemotePluginTrustDecision,
  type RemotePluginTrustPolicy,
  registerRemoteCapabilityPlugins,
  syncRemoteCapabilityPlugins,
} from "./services/remote-plugin-adapter.ts";
export {
  createTeeGatedRemoteSigningService,
  type PendingApproval,
  RemoteSigningRuntimeService,
  RemoteSigningService,
  type RemoteSigningServiceConfig,
  type SignerBackend,
  type SigningResult,
  type TeeGatedRemoteSigningConfig,
  type UnsignedTransaction,
} from "./services/remote-signing-service.ts";
export {
  AppleContainerEngine,
  buildContainerExecArgs,
  type ContainerExecOptions,
  type ContainerExecResult,
  type ContainerRunOptions,
  createEngine,
  DockerEngine,
  detectBestEngine,
  type EngineInfo,
  getAllEngineInfo,
  getPlatformSetupNotes,
  type ISandboxEngine,
  type SandboxEngineType,
} from "./services/sandbox-engine.ts";
export {
  type SandboxEvent,
  type SandboxExecOptions,
  type SandboxExecResult,
  SandboxManager,
  type SandboxManagerConfig,
  type SandboxMode,
  type SandboxRunOptions,
  type SandboxState,
} from "./services/sandbox-manager.ts";
export {
  buildUpdateCommand,
  detectInstallMethod,
  getUpdateActionPlan,
  type InstallMethod,
  performUpdate,
  type UpdateActionPlan,
  type UpdateAuthority,
  type UpdateCommandInfo,
  type UpdateNextAction,
  type UpdateResult,
} from "./services/self-updater.ts";
// Re-export the shell-execution router by name to keep a stable surface for
// callers that consume the chokepoint directly without unpacking the wider
// services barrel.
export {
  resolveShellExecutionMode,
  runShell,
  type ShellExecutionMode,
  type ShellRequest,
  type ShellResult,
  type ShellRouterContext,
  type ShellSandboxBackend,
} from "./services/shell-execution-router.ts";
export {
  createDefaultPolicy,
  type PolicyDecision,
  type SigningPolicy,
  SigningPolicyEvaluator,
  type SigningRequest,
} from "./services/signing-policy.ts";
export * from "./services/tee-boot-gate.ts";
export * from "./services/tee-boot-gate-state.ts";
export * from "./services/tee-confidential-inference.ts";
export * from "./services/tee-evidence.ts";
export * from "./services/tee-evidence-provider.ts";
export * from "./services/tee-key-release.ts";
export * from "./services/tee-model-key-boot.ts";
export * from "./services/tee-policy.ts";
export * from "./services/tee-production-profile.ts";
export * from "./services/tee-release-policy.ts";
export * from "./services/tee-revocation.ts";
export * from "./services/tee-runtime-config.ts";
export * from "./services/tee-sealed-volume.ts";
export * from "./services/tee-signer-backend.ts";
export {
  CHANNEL_DIST_TAGS,
  checkForUpdate,
  fetchAllChannelVersions,
  resolveChannel,
  type UpdateCheckResult,
} from "./services/update-checker.ts";
export {
  AI_PROVIDER_PLUGINS,
  compareSemver,
  diagnoseNoAIProvider,
  parseSemver,
} from "./services/version-compat.ts";
export {
  createVirtualFilesystemService,
  type VirtualFilesystemDiffEntry,
  type VirtualFilesystemDiffStatus,
  type VirtualFilesystemEntry,
  VirtualFilesystemError,
  type VirtualFilesystemExportFile,
  type VirtualFilesystemOptions,
  type VirtualFilesystemQuota,
  type VirtualFilesystemRollback,
  VirtualFilesystemService,
  type VirtualFilesystemSnapshot,
} from "./services/virtual-filesystem.ts";
export { resolveDefaultAgentWorkspaceDir } from "./shared/workspace-resolution.ts";
export * from "./triggers/humanize.ts";
export * from "./triggers/runtime.ts";
export * from "./triggers/scheduling.ts";
export * from "./triggers/types.ts";
export type {
  AutonomousConfigLike,
  CloudProxyConfigLike,
} from "./types/config-like.ts";
export type {
  Trajectory,
  TrajectoryActionAttempt,
  TrajectoryCacheStats,
  TrajectoryExportFormat,
  TrajectoryExportOptions,
  TrajectoryExportResult,
  TrajectoryFlattenedLlmCall,
  TrajectoryJsonShape,
  TrajectoryListItem,
  TrajectoryListOptions,
  TrajectoryListResult,
  TrajectoryLlmCall,
  TrajectoryProviderAccess,
  TrajectorySkillInvocation,
  TrajectoryStatus,
  TrajectoryStep,
  TrajectoryStepId,
  TrajectoryStepKind,
  TrajectoryUsageTotals,
} from "./types/trajectory.ts";
export * from "./version-resolver.ts";

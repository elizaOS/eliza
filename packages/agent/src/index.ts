export type {
  InventoryProviderOption,
  ModelOption,
  SubscriptionCredentialSource,
  WalletChainKind,
  WalletEntry,
  WalletPrimaryMap,
  WalletProviderKind,
  WalletSource,
} from "@elizaos/shared";
export * from "@elizaos/shared";
export {
  type ExtractActionParamsArgs,
  extractActionParamsViaLlm,
  type ParamSchemaDescriptor,
} from "./actions/extract-params.js";
export * from "./actions/index.js";
export type { CloudConfigLike } from "./api/cloud-status-routes.js";
export * from "./api/config-env.js";
export * from "./api/conversation-metadata.js";
export * from "./api/index.js";
export {
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./api/plugin-discovery-helpers.js";
export * from "./api/plugin-runtime-apply.js";
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
  validateMcpServerConfig,
} from "./api/server.js";
// Re-export non-colliding helpers from `./api/server-auth.js`. Names that
// `./api/server.js` already re-exports are intentionally omitted here so the
// canonical `server.js` definitions remain authoritative.
export {
  getConfiguredApiToken,
  isLoopbackBindHost,
  isTrustedLocalRequest,
  type PluginConfigMutationRejection,
  tokenMatches,
} from "./api/server-auth.js";
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
} from "./api/server-helpers.js";
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
} from "./api/server-types.js";
export * from "./api/wallet-capability.js";
export * from "./api/workbench-helpers.js";
export * from "./auth/index.js";
export { resolveCloudApiBaseUrl } from "./cloud/base-url.js";
export * from "./cloud/index.js";
export { CharacterSchema } from "./config/character-schema.js";
export {
  configFileExists,
  loadElizaConfig,
  saveElizaConfig,
} from "./config/config.js";
export {
  CONNECTOR_ENV_MAP,
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "./config/env-vars.js";
export {
  CircularIncludeError,
  ConfigIncludeError,
  deepMerge,
  INCLUDE_KEY,
  type IncludeResolver,
  MAX_INCLUDE_DEPTH,
  resolveConfigIncludes,
} from "./config/includes.js";
export { isPlainObject } from "./config/object-utils.js";
export {
  loadOwnerContactRoutingHints,
  loadOwnerContactsConfig,
  type OwnerContactPlatformIdentity,
  type OwnerContactResolution,
  type OwnerContactRoutingHint,
  resolveOwnerContactSource,
  resolveOwnerContactWithFallback,
} from "./config/owner-contacts.js";
export {
  getElizaNamespace,
  resolveConfigPath,
  resolveDefaultConfigCandidates,
  resolveModelsCacheDir,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
  resolveStewardCredentialsPath,
  resolveUserPath,
} from "./config/paths.js";
export {
  type ApplyPluginAutoEnableParams,
  type ApplyPluginAutoEnableResult,
  AUTH_PROVIDER_PLUGINS,
  applyPluginAutoEnable,
  applyPluginSelfDeclaredAutoEnable,
  CONNECTOR_PLUGINS,
  isConnectorConfigured,
  isStreamingDestinationConfigured,
  STREAMING_PLUGINS,
} from "./config/plugin-auto-enable.js";
export {
  buildConfigSchema,
  CONNECTOR_IDS,
  type ConfigSchema,
  type ConfigSchemaResponse,
  type ConfigUiHint,
  type ConfigUiHints,
  type ConnectorUiMetadata,
  type PluginUiMetadata,
  type ShowIfCondition,
} from "./config/schema.js";
export {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
  TELEGRAM_COMMAND_NAME_PATTERN,
  type TelegramCustomCommandInput,
  type TelegramCustomCommandIssue,
} from "./config/telegram-custom-commands.js";
export * from "./diagnostics/integration-observability.js";
export * from "./hooks/index.js";
export * from "./providers/workspace.js";
export * from "./runtime/advanced-capabilities-config.js";
export * from "./runtime/agent-event-service.js";
export * from "./runtime/core-plugins.js";
export * from "./runtime/eliza.js";
export * from "./runtime/eliza-plugin.js";
export * from "./runtime/embedding-presets.js";
export * from "./runtime/onboarding-names.js";
export * from "./runtime/owner-entity.js";
export * from "./runtime/plugin-collector.js";
export * from "./runtime/plugin-lifecycle.js";
export {
  getLastFailedPluginNames,
  resolvePlugins,
} from "./runtime/plugin-resolver.js";
export * from "./runtime/plugin-types.js";
export * from "./runtime/release-plugin-policy.js";
export * from "./runtime/trajectory-internals.js";
export * from "./runtime/trajectory-persistence.js";
export * from "./runtime/trajectory-query.js";
export * from "./runtime/version.js";
export * from "./security/index.js";
export * from "./services/index.js";
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
} from "./services/relationships-graph.js";
export * from "./test-support/index.js";
export * from "./test-utils/sqlite-compat.js";
export * from "./triggers/action.js";
export * from "./triggers/runtime.js";
export * from "./triggers/scheduling.js";
export * from "./triggers/types.js";
// `types/index.js` aggregates `agent-skills`, `config-like`, and `trajectory`.
export * from "./types/index.js";
export * from "./utils/number-parsing.js";
export * from "./version-resolver.js";

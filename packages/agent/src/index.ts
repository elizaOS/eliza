export type { CloudConfigLike } from "@elizaos/plugin-elizacloud";
export {
  handleCloudBillingRoute,
  handleCloudCompatRoute,
} from "@elizaos/plugin-elizacloud";
export type { ElizaConfig, ReleaseChannel, RolesConfig } from "@elizaos/shared";
export {
  type ExtractActionParamsArgs,
  extractActionParamsViaLlm,
  type ParamSchemaDescriptor,
} from "./actions/extract-params.js";
export * from "./actions/index.js";
export * from "./api/config-env.js";
export * from "./api/conversation-metadata.js";
export * from "./api/index.js";
export {
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./api/plugin-discovery-helpers.js";
export * from "./api/plugin-runtime-apply.js";
export { RegistryService } from "./api/registry-service.js";
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
export {
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  TxService,
} from "./api/tx-service.js";
export { getWalletAddresses } from "./api/wallet.js";
export * from "./api/wallet-capability.js";
export * from "./api/workbench-helpers.js";
export * from "./auth/index.js";
export * from "./awareness/index.js";
export { runBenchmark } from "./cli/benchmark.js";
export { CharacterSchema } from "./config/character-schema.js";
export * from "./config/index.js";
// `contracts/awareness.js` adds the local-only (non-shared) contract surface.
// Config media/custom-action contract types are exported from `./config/index.js`
// (via `@elizaos/shared`); do not re-export `./contracts/config.js` here or
// `tsc` reports duplicate symbol errors (TS2308).
export * from "./contracts/awareness.js";
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
export * from "./runtime/operations/vault-bridge.js";
export * from "./runtime/owner-entity.js";
export * from "./runtime/plugin-collector.js";
export * from "./runtime/plugin-lifecycle.js";
export {
  getLastFailedPluginNames,
  resolvePlugins,
} from "./runtime/plugin-resolver.js";
export * from "./runtime/plugin-types.js";
export * from "./runtime/release-plugin-policy.js";
export * from "./runtime/restart.js";
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
export * from "./triggers/runtime.js";
export * from "./triggers/scheduling.js";
export * from "./triggers/types.js";
// `types/index.js` aggregates `agent-skills`, `config-like`, and `trajectory`.
export * from "./types/index.js";
export * from "./utils/number-parsing.js";
export * from "./version-resolver.js";

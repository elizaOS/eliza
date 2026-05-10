export {
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
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
} from "./actions/extract-params.ts";
export * from "./actions/index.ts";
export * from "./api/config-env.ts";
export { handleConnectorAccountRoutes } from "./api/connector-account-routes.ts";
export * from "./api/conversation-metadata.ts";
export * from "./api/index.ts";
export { setOwnerContact } from "./api/owner-contact-helpers.ts";
export {
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./api/plugin-discovery-helpers.ts";
export * from "./api/plugin-runtime-apply.ts";
export { RegistryService } from "./api/registry-service.ts";
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
} from "./api/server.ts";
// Re-export non-colliding helpers from `./api/server-auth.js`. Names that
// `./api/server.js` already re-exports are intentionally omitted here so the
// canonical `server.js` definitions remain authoritative.
export {
  getConfiguredApiToken,
  isLoopbackBindHost,
  isTrustedLocalRequest,
  type PluginConfigMutationRejection,
  tokenMatches,
} from "./api/server-auth.ts";
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
export { getWalletAddresses } from "./api/wallet.ts";
export * from "./api/wallet-capability.ts";
export * from "./api/workbench-helpers.ts";
export * from "./auth/index.ts";
export * from "./awareness/index.ts";
export { runBenchmark } from "./cli/benchmark.ts";
export { CharacterSchema } from "./config/character-schema.ts";
export * from "./config/index.ts";
// `contracts/awareness.js` adds the local-only (non-shared) contract surface.
// Config media/custom-action contract types are exported from `./config/index.js`
// (via `@elizaos/shared`); do not re-export `./contracts/config.js` here or
// `tsc` reports duplicate symbol errors (TS2308).
export * from "./contracts/awareness.ts";
export * from "./diagnostics/integration-observability.ts";
export * from "./hooks/index.ts";
export * from "./providers/workspace.ts";
export * from "./runtime/advanced-capabilities-config.ts";
export * from "./runtime/agent-event-service.ts";
export * from "./runtime/core-plugins.ts";
export * from "./runtime/eliza.ts";
export * from "./runtime/eliza-plugin.ts";
export * from "./runtime/embedding-presets.ts";
export {
  isCloudExecutionMode,
  type LocalExecutionMode,
  type RuntimeExecutionMode,
  type RuntimeExecutionModeSource,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  shouldUseSandboxExecution,
} from "./runtime/local-execution-mode.ts";
export * from "./runtime/onboarding-names.ts";
export * from "./runtime/operations/vault-bridge.ts";
export * from "./runtime/owner-entity.ts";
export * from "./runtime/plugin-collector.ts";
export * from "./runtime/plugin-lifecycle.ts";
export {
  getLastFailedPluginNames,
  resolvePlugins,
} from "./runtime/plugin-resolver.ts";
export * from "./runtime/plugin-types.ts";
export * from "./runtime/release-plugin-policy.ts";
export * from "./runtime/restart.ts";
export * from "./runtime/trajectory-internals.ts";
export * from "./runtime/trajectory-persistence.ts";
export * from "./runtime/trajectory-query.ts";
export * from "./runtime/version.ts";
export * from "./security/index.ts";
export {
  isStewardEvmBridgeActive,
  setStewardEvmBridgeActive,
} from "./services/external-bridge-state.ts";
export * from "./services/index.ts";
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
export * from "./services/plugin-installer";
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
  getLoadedVfsPlugins,
  type LoadedVfsPlugin,
  loadPluginFromVfs,
  type LoadPluginFromVfsOptions,
  unloadPluginFromVfs,
  type UnloadPluginFromVfsOptions,
} from "./runtime/load-plugin-from-vfs.ts";
export {
  runShell,
  type ShellExecutionMode,
  type ShellRequest,
  type ShellResult,
  type ShellRouterContext,
  type ShellSandboxBackend,
} from "./services/shell-execution-router.ts";
export * from "./test-support/index.ts";
export * from "./test-utils/sqlite-compat.ts";
export * from "./triggers/runtime.ts";
export * from "./triggers/scheduling.ts";
export * from "./triggers/text-to-workflow.ts";
export * from "./triggers/types.ts";
// `types/index.js` aggregates `agent-skills`, `config-like`, and `trajectory`.
export * from "./types/index.ts";
export * from "./utils/number-parsing.ts";
export * from "./version-resolver.ts";

// ── Compat re-exports for the published `@elizaos/app-core` alpha bundle ──
//
// `@elizaos/app-core@2.0.0-alpha.537` (the version embedded in
// `eliza-dist` for packaged Electrobun and the AOSP installer) imports
// these names from `@elizaos/agent`. The agent's API surface was reorganised
// in commit 334a6ea2 — the symbols moved out into
// `@elizaos/plugin-elizacloud`, `./api/provider-switch-config`,
// `./config/config`, `./config/paths`, `./api/wallet`, and
// `./shared/workspace-resolution` without the corresponding agent-side
// re-exports. Until app-core is republished against the new surface the
// embedded runtime fails to start with `SyntaxError: Export named ...`,
// so we restore them here as a thin compat layer.
//
// New code should import each from its real home:
//   • cloud helpers → `@elizaos/plugin-elizacloud`
//   • provider/onboarding config helpers → `./api/provider-switch-config`
//   • elizaConfig file IO → `./config/config`
//   • wallet helpers → `./api/wallet`
//   • workspace resolution → `./shared/workspace-resolution`
//   • user path resolution → `./config/paths`
export {
  resolveCloudApiBaseUrl,
  validateCloudBaseUrl,
} from "@elizaos/plugin-elizacloud";
export {
  applyCanonicalOnboardingConfig,
  clearPersistedOnboardingConfig,
} from "./api/provider-switch-config.ts";
export { loadElizaConfig, saveElizaConfig } from "./config/config.ts";
export { resolveUserPath } from "./config/paths.ts";
export { initStewardWalletCache } from "./api/wallet.ts";
export { resolveDefaultAgentWorkspaceDir } from "./shared/workspace-resolution.ts";

export {
  DEFAULT_MAX_BODY_BYTES,
  readJsonBody,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
export interface CloudConfigLike {
  apiKey?: string | null;
  baseUrl?: string | null;
  [key: string]: unknown;
}

type CloudRouteHandler = (...args: unknown[]) => Promise<boolean>;
type CloudUrlValidator = (value: string) => Promise<string | null>;
type ElizaCloudRoutesModule = {
  handleCloudBillingRoute: CloudRouteHandler;
  handleCloudCompatRoute: CloudRouteHandler;
  handleCloudRoute: CloudRouteHandler;
  validateCloudBaseUrl: CloudUrlValidator;
};

async function loadElizaCloudRoutes(): Promise<ElizaCloudRoutesModule> {
  return import(
    "@elizaos/plugin-elizacloud"
  ) as unknown as Promise<ElizaCloudRoutesModule>;
}

export async function handleCloudBillingRoute(
  ...args: unknown[]
): Promise<boolean> {
  const { handleCloudBillingRoute } = await loadElizaCloudRoutes();
  return handleCloudBillingRoute(...args);
}

export async function handleCloudCompatRoute(
  ...args: unknown[]
): Promise<boolean> {
  const { handleCloudCompatRoute } = await loadElizaCloudRoutes();
  return handleCloudCompatRoute(...args);
}

export async function handleCloudRoute(...args: unknown[]): Promise<boolean> {
  const { handleCloudRoute } = await loadElizaCloudRoutes();
  return handleCloudRoute(...args);
}

export async function validateCloudBaseUrl(
  value: string,
): Promise<string | null> {
  const { validateCloudBaseUrl } = await loadElizaCloudRoutes();
  return validateCloudBaseUrl(value);
}
export type { ElizaConfig, ReleaseChannel, RolesConfig } from "@elizaos/shared";
export {
  CONNECTOR_PLUGINS,
  normalizeCloudSiteUrl,
  type ParseClampedIntegerOptions,
  type ParseClampedNumberOptions,
  type ParsePositiveNumberOptions,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
  resolveCloudApiBaseUrl,
  STREAMING_PLUGINS,
} from "@elizaos/shared";
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
export {
  applyCanonicalOnboardingConfig,
  clearPersistedOnboardingConfig,
} from "./api/provider-switch-config.ts";
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
export { getWalletAddresses, initStewardWalletCache } from "./api/wallet.ts";
export * from "./api/wallet-capability.ts";
export * from "./api/workbench-helpers.ts";
export * from "./auth/index.ts";
export * from "./awareness/index.ts";
export { runBenchmark } from "./cli/benchmark.ts";
export { CharacterSchema } from "./config/character-schema.ts";
export { loadElizaConfig, saveElizaConfig } from "./config/config.ts";
export * from "./config/index.ts";
export { resolveUserPath } from "./config/paths.ts";
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
// === Phase 3C: barrel-promoted from ./runtime/tool-call-cache/index ===
export {
  buildCacheKey,
  CACHEABLE_TOOL_REGISTRY,
  type CacheableToolDescriptor,
  canonicalizeJson,
  defaultPrivacyRedactor,
  isCacheable,
  type PrivacyRedactor,
  resolveToolDescriptor,
  type ToolArgs,
  type ToolCacheEntry,
  ToolCallCache,
  type ToolCallCacheOptions,
  type ToolOutput,
} from "./runtime/tool-call-cache/index.ts";
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
// === Phase 3C: barrel-promoted from ./services/permissions/probers/index ===
export {
  ALL_PROBERS,
  PROBERS_BY_ID,
} from "./services/permissions/probers/index.ts";
// === Phase 3C: barrel-promoted from ./services/permissions/register-probers ===
export { registerAllProbers } from "./services/permissions/register-probers.ts";
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
// Re-export the shell-execution router by name to keep a stable surface for
// callers that consume the chokepoint directly without unpacking the wider
// services barrel.
export {
  runShell,
  type ShellExecutionMode,
  type ShellRequest,
  type ShellResult,
  type ShellRouterContext,
  type ShellSandboxBackend,
} from "./services/shell-execution-router.ts";
export { resolveDefaultAgentWorkspaceDir } from "./shared/workspace-resolution.ts";
export * from "./test-support/index.ts";
export * from "./test-utils/sqlite-compat.ts";
export * from "./triggers/runtime.ts";
export * from "./triggers/scheduling.ts";
export * from "./triggers/text-to-workflow.ts";
export * from "./triggers/types.ts";
// `types/index.js` aggregates `agent-skills`, `config-like`, and `trajectory`.
export * from "./types/index.ts";
export * from "./version-resolver.ts";

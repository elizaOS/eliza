import "@elizaos/shared";
import http from "node:http";
import {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  cloneWithoutBlockedObjectKeys,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  type ElizaConfig,
  extractAuthToken,
  fetchWithTimeoutGuard,
  isAllowedHost,
  isAuthorized,
  normalizeWsClientId,
  persistConversationRoomTitle,
  resolveMcpServersRejection,
  resolvePluginConfigMutationRejections,
  routeAutonomyTextToUser,
  streamResponseBodyWithByteLimit,
  startApiServer as upstreamStartApiServer,
  validateMcpServerConfig,
} from "@elizaos/agent";
import { type AgentRuntime } from "@elizaos/core";
import { type CompatRuntimeState } from "./compat-route-shared";

export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "@elizaos/shared";
export {
  type CompatRuntimeState,
  DATABASE_UNAVAILABLE_MESSAGE,
  getConfiguredCompatAgentName,
  hasCompatPersistedOnboardingState,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "./compat-route-shared";
export {
  filterConfigEnvForResponse,
  SENSITIVE_ENV_RESPONSE_KEYS,
} from "./server-config-filter";
export {
  buildCorsAllowedPorts,
  invalidateCorsAllowedPorts,
} from "./server-cors";
export { injectApiBaseIntoHtml } from "./server-html";
export {
  ensureApiTokenForBindHost,
  resolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
} from "./server-security";
export {
  findOwnPackageRoot,
  isSafeResetStateDir,
  resolveCorsOrigin,
} from "./server-startup";
export { resolveWalletExportRejection } from "./server-wallet-trade";
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  cloneWithoutBlockedObjectKeys,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  extractAuthToken,
  fetchWithTimeoutGuard,
  isAllowedHost,
  isAuthorized,
  normalizeWsClientId,
  persistConversationRoomTitle,
  resolveMcpServersRejection,
  resolvePluginConfigMutationRejections,
  routeAutonomyTextToUser,
  streamResponseBodyWithByteLimit,
  validateMcpServerConfig,
};
export declare function syncCompatConfigFiles(): void;
/**
 * Reset hop for `POST /api/agent/reset`. Deliberately operates entirely
 * in-process: stops the runtime then removes the PGlite data dir.
 *
 * Must NOT issue loopback HTTP requests back to this same server — the
 * single Node listener can't service the outer request and a re-entrant
 * call simultaneously and the request hangs (issue #7409).
 *
 * Exported via `_clearCompatPgliteDataDirForTests` for the regression
 * test that asserts no `fetch()` is invoked during reset.
 */
declare function clearCompatPgliteDataDir(
  runtime: AgentRuntime | null,
  config: ElizaConfig,
): Promise<void>;
export declare const _clearCompatPgliteDataDirForTests: typeof clearCompatPgliteDataDir;
export declare function handleElizaCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
export declare function getSharedCompatRuntimeState(): CompatRuntimeState;
export declare function patchHttpCreateServerForCompat(): () => void;
export declare function startApiServer(
  ...args: Parameters<typeof upstreamStartApiServer>
): Promise<Awaited<ReturnType<typeof upstreamStartApiServer>>>;
//# sourceMappingURL=server.d.ts.map

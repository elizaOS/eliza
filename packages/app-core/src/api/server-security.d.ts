/**
 * Security / auth helpers — WebSocket upgrade rejection, terminal run
 * rejection, MCP terminal authorization, and API token binding.
 */
import {
  ensureApiTokenForBindHost as upstreamEnsureApiTokenForBindHost,
  resolveMcpTerminalAuthorizationRejection as upstreamResolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId as upstreamResolveTerminalRunClientId,
  resolveTerminalRunRejection as upstreamResolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection as upstreamResolveWebSocketUpgradeRejection,
} from "@elizaos/agent";
export declare function resolveMcpTerminalAuthorizationRejection(
  ...args: Parameters<typeof upstreamResolveMcpTerminalAuthorizationRejection>
): ReturnType<typeof upstreamResolveMcpTerminalAuthorizationRejection>;
export declare function resolveTerminalRunRejection(
  ...args: Parameters<typeof upstreamResolveTerminalRunRejection>
): ReturnType<typeof upstreamResolveTerminalRunRejection>;
export declare function resolveWebSocketUpgradeRejection(
  ...args: Parameters<typeof upstreamResolveWebSocketUpgradeRejection>
): ReturnType<typeof upstreamResolveWebSocketUpgradeRejection>;
export declare function resolveTerminalRunClientId(
  ...args: Parameters<typeof upstreamResolveTerminalRunClientId>
): ReturnType<typeof upstreamResolveTerminalRunClientId>;
export declare function ensureApiTokenForBindHost(
  ...args: Parameters<typeof upstreamEnsureApiTokenForBindHost>
): ReturnType<typeof upstreamEnsureApiTokenForBindHost>;
//# sourceMappingURL=server-security.d.ts.map

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
import { syncAppEnvToEliza, syncElizaEnvAliases } from "../utils/env.js";
import {
  normalizeCompatRejection,
  runWithCompatAuthContext,
} from "./server-wallet-trade";

export function resolveMcpTerminalAuthorizationRejection(
  ...args: Parameters<typeof upstreamResolveMcpTerminalAuthorizationRejection>
): ReturnType<typeof upstreamResolveMcpTerminalAuthorizationRejection> {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(
      upstreamResolveMcpTerminalAuthorizationRejection(...args),
    ),
  );
}

export function resolveTerminalRunRejection(
  ...args: Parameters<typeof upstreamResolveTerminalRunRejection>
): ReturnType<typeof upstreamResolveTerminalRunRejection> {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(upstreamResolveTerminalRunRejection(...args)),
  );
}

export function resolveWebSocketUpgradeRejection(
  ...args: Parameters<typeof upstreamResolveWebSocketUpgradeRejection>
): ReturnType<typeof upstreamResolveWebSocketUpgradeRejection> {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    upstreamResolveWebSocketUpgradeRejection(...args),
  );
}

export function resolveTerminalRunClientId(
  ...args: Parameters<typeof upstreamResolveTerminalRunClientId>
): ReturnType<typeof upstreamResolveTerminalRunClientId> {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    upstreamResolveTerminalRunClientId(...args),
  );
}

export function ensureApiTokenForBindHost(
  ...args: Parameters<typeof upstreamEnsureApiTokenForBindHost>
): ReturnType<typeof upstreamEnsureApiTokenForBindHost> {
  syncAppEnvToEliza();
  const result = upstreamEnsureApiTokenForBindHost(...args);
  syncElizaEnvAliases();
  return result;
}

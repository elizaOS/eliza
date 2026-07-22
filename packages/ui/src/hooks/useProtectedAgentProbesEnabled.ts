/**
 * Gate for shell data loaders that hit protected (auth-required) agent API
 * routes on mount.
 *
 * The shell must NOT probe these routes before a session exists on the shared
 * Eliza Cloud web app, or while a native bundle is unbound / points at a managed
 * Cloud agent. The former would 401; the latter can resolve `/api/*` against the
 * packaged SPA or race Cloud authentication. Once a session exists the probes
 * resume.
 *
 * Everywhere else (localhost, desktop/mobile local agents, self-hosted remotes)
 * the selected agent needs no Cloud session, so probes fire immediately — no
 * auth round-trip is inserted into those hot paths. Consumers:
 * `notifications-boot`, `useWeather`, `useRuntimeMode`, `useSlashCommandController`.
 */

import { useSyncExternalStore } from "react";
import { client } from "../api";
import { isNative } from "../platform";
import {
  directCloudSharedAgentIdFromBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
} from "../utils/cloud-agent-base";
import { useIsAuthenticated } from "./useAuthStatus";

export interface ProtectedAgentProbeRuntime {
  isNative: boolean;
  agentApiBase: string | null | undefined;
}

/**
 * Pure decision behind {@link useProtectedAgentProbesEnabled}: probes are
 * allowed once authenticated, or whenever the active origin/backend does not
 * require a managed Cloud session.
 */
export function protectedAgentProbesEnabled(
  authenticated: boolean,
  origin: string | null | undefined,
  runtime?: ProtectedAgentProbeRuntime,
): boolean {
  if (runtime?.isNative) {
    const apiBase = runtime.agentApiBase?.trim() ?? "";
    if (!apiBase) return false;
    if (
      isElizaCloudControlPlaneAgentlessBase(apiBase) ||
      isDedicatedCloudAgentBase(apiBase) ||
      directCloudSharedAgentIdFromBase(apiBase) !== null
    ) {
      return authenticated;
    }
    return true;
  }
  if (authenticated) return true;
  return !isElizaCloudControlPlaneAgentlessBase(origin ?? "");
}

export function useProtectedAgentProbesEnabled(): boolean {
  const authenticated = useIsAuthenticated();
  const agentApiBase = useSyncExternalStore(
    (listener) => client.onBaseUrlChange(listener),
    () => client.getBaseUrl(),
    () => "",
  );
  return protectedAgentProbesEnabled(
    authenticated,
    typeof window !== "undefined" ? window.location.origin : null,
    { isNative, agentApiBase },
  );
}

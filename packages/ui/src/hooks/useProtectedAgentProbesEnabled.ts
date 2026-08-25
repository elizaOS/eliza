/**
 * Gate for shell data loaders that hit protected (auth-required) agent API
 * routes on mount.
 *
 * The one origin where the shell must NOT probe those routes before a session
 * exists is the shared Eliza Cloud web app (`cloud.eliza.app` and the other
 * control-plane hosts): its same-origin `/api/*` is the managed cloud endpoint,
 * so every protected GET fired during fresh onboarding 401s and Chromium logs
 * each as a console error — the first-run noise of #16242. The in-chat first-run
 * conductor owns Cloud sign-in there; once a session exists the probes resume.
 *
 * Everywhere else, loopback/local agents need no cloud auth, so probes fire
 * immediately. Native remote authorities are the exception: the phone must
 * finish pairing before protected loaders run, or their expected 401s become
 * false unavailable cards during first run. Consumers:
 * `notifications-boot`, `useWeather`, `useRuntimeMode`, `useSlashCommandController`.
 */

import { Capacitor } from "@capacitor/core";
import { isLoopbackBindHost } from "@elizaos/shared";
import { client } from "../api";
import { isLimitedCloudAgentApiBase } from "../api/app-shell-capabilities";
import { isElizaCloudControlPlaneAgentlessBase } from "../utils/cloud-agent-base";
import { useIsAuthenticated } from "./useAuthStatus";

/**
 * Pure decision behind {@link useProtectedAgentProbesEnabled}: probes are
 * allowed once authenticated, or on an authority that is both non-Cloud and
 * local to the current host. Native non-loopback authorities require pairing.
 */
export function protectedAgentProbesEnabled(
  authenticated: boolean,
  origin: string | null | undefined,
  agentBase?: string | null,
  nativeRuntime = false,
): boolean {
  // Direct/shared Cloud agent adapters intentionally expose chat, status, and
  // history—not the full app-shell route family. Authentication cannot make
  // commands, custom actions, runtime mode, weather/location, or notification
  // routes appear, so probing them only creates 10-second startup contention.
  if (isLimitedCloudAgentApiBase(agentBase)) return false;
  // Capacitor serves bundled assets from a synthetic https://localhost origin,
  // not an app-shell API server. With no selected authority, `/api/*` would
  // just return the renderer HTML (and cannot become valid after auth alone).
  if (nativeRuntime) {
    const configuredBase = agentBase?.trim();
    if (!configuredBase) return false;
    if (!authenticated) {
      try {
        if (!isLoopbackBindHost(new URL(configuredBase).hostname)) return false;
      } catch {
        // error-policy:J3 an invalid native authority cannot become a
        // pre-authenticated protected-probe target.
        return false;
      }
    }
  }
  if (authenticated) return true;
  return !isElizaCloudControlPlaneAgentlessBase(origin ?? "");
}

export function useProtectedAgentProbesEnabled(): boolean {
  const authenticated = useIsAuthenticated();
  return protectedAgentProbesEnabled(
    authenticated,
    typeof window !== "undefined" ? window.location.origin : null,
    client.getBaseUrl(),
    Capacitor.isNativePlatform(),
  );
}

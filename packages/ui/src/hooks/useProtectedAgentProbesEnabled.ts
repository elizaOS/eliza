/**
 * Gate for shell data loaders that hit protected (auth-required) agent API
 * routes on mount.
 *
 * The one origin where the shell must NOT probe those routes before a session
 * exists is the shared Eliza Cloud web app (`app.elizacloud.ai` and the other
 * control-plane hosts): its same-origin `/api/*` is the managed cloud endpoint,
 * so every protected GET fired during fresh onboarding 401s and Chromium logs
 * each as a console error — the first-run noise of #16242. The in-chat first-run
 * conductor owns Cloud sign-in there; once a session exists the probes resume.
 *
 * Everywhere else (localhost, desktop/mobile local agents, self-hosted remotes)
 * the same-origin agent needs no cloud auth, so probes fire immediately — no
 * auth round-trip is inserted into those hot paths. Consumers:
 * `notifications-boot`, `useWeather`, `useRuntimeMode`, `useSlashCommandController`.
 */

import { isElizaCloudControlPlaneAgentlessBase } from "../utils/cloud-agent-base";
import { useIsAuthenticated } from "./useAuthStatus";

/**
 * Pure decision behind {@link useProtectedAgentProbesEnabled}: probes are
 * allowed once authenticated, or on any origin that is not a bare Eliza Cloud
 * control-plane host (where the same-origin agent needs no cloud session).
 */
export function protectedAgentProbesEnabled(
  authenticated: boolean,
  origin: string | null | undefined,
): boolean {
  if (authenticated) return true;
  return !isElizaCloudControlPlaneAgentlessBase(origin ?? "");
}

export function useProtectedAgentProbesEnabled(): boolean {
  const authenticated = useIsAuthenticated();
  return protectedAgentProbesEnabled(
    authenticated,
    typeof window !== "undefined" ? window.location.origin : null,
  );
}

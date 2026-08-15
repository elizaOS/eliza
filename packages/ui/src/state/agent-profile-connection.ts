/**
 * Installs a selected runtime profile on the live API client. Credential state
 * are cleared before the target URL changes, then the selected bearer is
 * installed. The temporary unauthenticated state prevents either the old or
 * new credential from being observable on the wrong backend.
 */

import type { AgentProfile } from "./agent-profile-types";

export interface AgentProfileConnectionClient {
  setBaseUrl(apiBase: string | null): void;
  setToken(token: string | null): void;
}

export function applyAgentProfileConnection(
  profile: AgentProfile,
  clientRef: AgentProfileConnectionClient,
): void {
  const sameOriginBase =
    typeof window === "undefined" ? null : window.location.origin;
  clientRef.setToken(null);
  clientRef.setBaseUrl(profile.apiBase || sameOriginBase);
  if (profile.accessToken) clientRef.setToken(profile.accessToken);
}

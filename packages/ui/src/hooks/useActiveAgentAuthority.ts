/**
 * Exposes the active agent API authority as reactive renderer state. Resource
 * caches use the same value so changing agents cannot reuse another agent's
 * data, and mounted capability views revalidate when the client is repointed.
 */

import { useSyncExternalStore } from "react";
import { client } from "../api/client";
import { loadAgentProfileRegistry } from "../state/agent-profiles";

type AuthorityAwareClient = {
  getBaseUrl?: () => string;
  getAuthorityRevision?: () => number;
  onAuthorityChange?: (onChange: () => void) => () => void;
  onBaseUrlChange?: (onChange: () => void) => () => void;
};

const authorityAwareClient: AuthorityAwareClient = client;

function sameOriginAuthority(): string {
  if (typeof window === "undefined") return "same-origin";
  return window.location.origin;
}

export function getActiveAgentAuthority(): string {
  const baseUrl =
    authorityAwareClient.getBaseUrl?.().trim() || sameOriginAuthority();
  const profileId =
    loadAgentProfileRegistry().activeProfileId?.trim() || "unscoped";
  const revision = authorityAwareClient.getAuthorityRevision?.() ?? 0;
  return `${profileId}\u0000${baseUrl}\u0000${revision}`;
}

function subscribeToActiveAgentAuthority(onChange: () => void): () => void {
  return (
    authorityAwareClient.onAuthorityChange?.(onChange) ??
    authorityAwareClient.onBaseUrlChange?.(onChange) ??
    (() => undefined)
  );
}

export function useActiveAgentAuthority(): string {
  return useSyncExternalStore(
    subscribeToActiveAgentAuthority,
    getActiveAgentAuthority,
    getActiveAgentAuthority,
  );
}

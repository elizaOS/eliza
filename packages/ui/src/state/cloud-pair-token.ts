/**
 * Delete channel for the durable cloud-pair API token (#16666).
 *
 * `persistCloudPairApiToken` (CloudPairRelay) writes the key into BOTH
 * sessionStorage and localStorage so an installed PWA survives relaunch; boot
 * adoption (packages/app main.tsx) then re-adopts whatever it finds on every
 * launch. Until this module existed there was no remover anywhere, so a
 * rotated/revoked agent credential was re-adopted forever. Kept as its own
 * module (not folded into the persistence grab-bag) because future explicit
 * flows — sign-out, unpair, agent deletion — need the same clear.
 *
 * `clearStalePairCredentialsForAgent` is the only purge callers should reach
 * for: it demands a target agent and clears nothing unless the persisted state
 * actually belongs to that agent. The raw `clearCloudPairApiToken` stays
 * exported for the explicit-flow clears above.
 */

import {
  CLOUD_PAIR_LOCAL_STORAGE_KEY,
  CLOUD_PAIR_SESSION_STORAGE_KEY,
} from "../components/auth/CloudPairRelay";
import { shellLocalStorage } from "../surface-realm-channel";
import {
  type AgentProfile,
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
} from "./agent-profiles";
import {
  dedicatedAgentIdFromApiBase,
  resolveDedicatedAgentId,
} from "./agent-session-recovery";
import {
  loadPersistedActiveServer,
  scrubPersistedActiveServerToken,
} from "./persistence";

/**
 * Mirrors the write channel's `tryPersistBrowserStorage` shape: report whether
 * the removal took, swallowing only storage-access failures.
 */
function tryRemoveFromStorage(remove: () => void): boolean {
  try {
    remove();
    return true;
  } catch (_storageError) {
    // error-policy:J3 hardened settings can disable storage; a store we cannot
    // touch also cannot be re-adopted from, so the purge goal still holds.
    return false;
  }
}

/**
 * Remove the durable pair token from BOTH storages the write channel targets.
 * Storage-scoped on purpose — the live bearer/boot-config are left alone so
 * in-flight requests are not broken; the auth wall renders next and the next
 * boot finds nothing to re-adopt. sessionStorage is addressed raw (mirroring
 * the write channel, which uses raw window storage; there is no
 * shellSessionStorage wrapper).
 */
export function clearCloudPairApiToken(): void {
  tryRemoveFromStorage(() => {
    shellLocalStorage.removeItem(CLOUD_PAIR_LOCAL_STORAGE_KEY);
  });
  tryRemoveFromStorage(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(CLOUD_PAIR_SESSION_STORAGE_KEY);
    }
  });
}

/** A cloud profile belongs to `agentId` via its explicit id or its API base. */
function profileMatchesDedicatedAgent(
  profile: AgentProfile,
  agentId: string,
): boolean {
  if (profile.kind !== "cloud") return false;
  if (profile.cloudAgentId === agentId) return true;
  return dedicatedAgentIdFromApiBase(profile.apiBase) === agentId;
}

/**
 * Purge the persisted credentials for ONE dedicated cloud agent whose adopted
 * bearer a caller has independently observed rejected. The pairing mint is
 * authorized by the Steward JWT, not the pair token, so a mint 401/403 alone
 * proves nothing about the pair token — only a caller that watched the agent
 * origin refuse the adopted bearer (e.g. `/api/auth/me` 401 with
 * `remote_auth_required`) may invoke this, and only for that agent.
 *
 * Scoped on both axes:
 * - The durable pair key + active-server token are cleared ONLY when the
 *   persisted active server resolves to `agentId` — the key holds whatever
 *   bearer boot adoption stamped for the ACTIVE dedicated agent, so a mismatch
 *   means the key belongs to a different (unproven) credential and survives.
 * - Agent-profile tokens are scrubbed ONLY for profiles that belong to
 *   `agentId`; unrelated profiles (other agents, local/remote runtimes) keep
 *   their still-valid credentials.
 */
export function clearStalePairCredentialsForAgent(agentId: string): void {
  const target = agentId.trim();
  if (!target) return;

  const activeServer = loadPersistedActiveServer();
  if (activeServer && resolveDedicatedAgentId(activeServer) === target) {
    clearCloudPairApiToken();
    scrubPersistedActiveServerToken();
  }

  const registry = loadAgentProfileRegistry();
  let changed = false;
  registry.profiles = registry.profiles.map((profile) => {
    if (!profile.accessToken) return profile;
    if (!profileMatchesDedicatedAgent(profile, target)) return profile;
    changed = true;
    const { accessToken: _dropped, ...rest } = profile;
    return rest;
  });
  if (changed) saveAgentProfileRegistry(registry);
}

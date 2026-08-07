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
  cloudPairTokenKeyForAgent,
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
 * the removal took, swallowing only storage-access failures. A failed purge is
 * logged so a dodgy storage channel cannot silently look like success
 * (error-policy:J6 best-effort removal).
 */
function tryRemoveFromStorage(remove: () => void, key?: string): boolean {
  try {
    remove();
    return true;
  } catch (_storageError) {
    // error-policy:J6 hardened settings can disable storage; a store we
    // cannot touch also cannot be re-adopted from, so the purge goal still
    // holds. Still log the failure so "disconnect succeeded" is not a lie.
    console.error(
      `Failed to remove cloud-pair token key${key ? ` (${key})` : ""} from storage.`,
    );
    return false;
  }
}

/** Remove one key from both storage backends, each deletion isolated so a
 * failing store cannot abort clearing the rest. */
function removePairKeyFromBothStorages(key: string): void {
  tryRemoveFromStorage(() => {
    shellLocalStorage.removeItem(key);
  }, key);
  tryRemoveFromStorage(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(key);
    }
  }, key);
}

/**
 * Remove the durable pair token from BOTH storages the write channel targets,
 * for the given owning agent (per-agent key) plus the legacy global key.
 * Storage-scoped on purpose — the live bearer/boot-config are left alone so
 * in-flight requests are not broken; the auth wall renders next and the next
 * boot finds nothing to re-adopt. sessionStorage is addressed raw (mirroring
 * the write channel, which uses raw window storage; there is no
 * shellSessionStorage wrapper).
 */
/** Prefix for all per-agent cloud-pair token keys */
const CLOUD_PAIR_SCOPED_PREFIX = "eliza:cloud-pair:api-token:";

/**
 * Remove all scoped cloud-pair token keys from localStorage.
 * Used when an explicit disconnect happens but we can't resolve a specific agentId.
 */
function clearAllScopedCloudPairKeys(): void {
  // shellLocalStorage only has setItem/removeItem/clear; enumerate via raw
  // localStorage (keys known), then remove each through the isolated helper so
  // one failing remove cannot abort clearing the rest.
  let scoped: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(CLOUD_PAIR_SCOPED_PREFIX)) scoped.push(key);
    }
  } catch (_storageError) {
    scoped = [];
  }
  for (const k of scoped) removePairKeyFromBothStorages(k);
  // Legacy single-key format
  removePairKeyFromBothStorages(CLOUD_PAIR_LOCAL_STORAGE_KEY);
}

/**
 * Remove all scoped cloud-pair token keys from sessionStorage.
 */
function clearAllScopedCloudPairKeysSession(): void {
  if (typeof window === "undefined") return;
  let keysToRemove: string[] = [];
  try {
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(CLOUD_PAIR_SCOPED_PREFIX)) keysToRemove.push(key);
    }
  } catch (_storageError) {
    keysToRemove = [];
  }
  // sessionStorage is addressed raw (no shellSessionStorage wrapper); the
  // isolated deletion below mirrors the write channel.
  for (const key of keysToRemove) {
    tryRemoveFromStorage(() => {
      window.sessionStorage.removeItem(key);
    }, key);
  }
  tryRemoveFromStorage(() => {
    window.sessionStorage.removeItem(CLOUD_PAIR_SESSION_STORAGE_KEY);
  }, CLOUD_PAIR_SESSION_STORAGE_KEY);
}

export function clearCloudPairApiToken(agentId?: string): void {
  const scopedKey = agentId?.trim()
    ? cloudPairTokenKeyForAgent(agentId.trim())
    : null;

  if (scopedKey) {
    // Clear specific agent's scoped key + legacy global key
    removePairKeyFromBothStorages(scopedKey);
    removePairKeyFromBothStorages(CLOUD_PAIR_LOCAL_STORAGE_KEY);
  } else {
    // No agentId resolved — explicit disconnect with global intent.
    // Clear ALL scoped keys + legacy key from both storages.
    clearAllScopedCloudPairKeys();
    clearAllScopedCloudPairKeysSession();
  }
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
  // The durable key is per-agent, so purge THIS agent's scoped key + the
  // legacy global key regardless of which agent is the active server. The
  // oldest guard ("only when activeServer resolves to target") was correct
  // when the key was GLOBAL — it must never skip the per-agent key of the
  // deleted agent (#17579).
  clearCloudPairApiToken(target);
  // The persisted active-server bearer is ONLY scrubbed when it actually
  // belongs to the deleted agent; an active server for a different agent
  // keeps its still-valid credential.
  if (activeServer && resolveDedicatedAgentId(activeServer) === target) {
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

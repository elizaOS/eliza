/**
 * Multi-agent profile registry.
 *
 * Stores a catalogue of known agent connections (local, cloud, remote) in
 * localStorage so users can manage and switch between multiple agents.
 */

import { logger } from "@elizaos/logger";
import { shellLocalStorage } from "../surface-realm-channel";
import { isManagedCloudSharedAgentBase } from "../utils/cloud-agent-base";
import type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";
import {
  type PersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";

export type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";

/* ── Helpers ─────────────────────────────────────────────────────────── */

const STORAGE_KEY = "elizaos:agent-profiles";
const ACTIVE_SERVER_KEY = "elizaos:active-server";

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    // error-policy:J3 inaccessible or malformed browser storage is an invalid
    // persisted state, so readers return their explicit bootstrap fallback.
    return fallback;
  }
}

function describePersistenceError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function generateId(): string {
  return crypto.randomUUID();
}

function emptyRegistry(): AgentProfileRegistry {
  return { version: 1, activeProfileId: null, profiles: [] };
}

/**
 * Attempt to migrate a single-agent `PersistedActiveServer` entry into a
 * profile registry.  Returns null if no prior server is found.
 */
function migrateFromPersistedActiveServer(): AgentProfileRegistry | null {
  const raw = localStorage.getItem(ACTIVE_SERVER_KEY);
  if (!raw) return null;

  let parsed: PersistedActiveServer;
  try {
    parsed = JSON.parse(raw) as PersistedActiveServer;
  } catch {
    // error-policy:J3 corrupt persisted server entry — migration starts from
    // an empty registry rather than wedging profile bootstrap.
    return null;
  }

  if (!parsed.kind || !parsed.id || !parsed.label) return null;

  const profile: AgentProfile = {
    id: generateId(),
    label: parsed.label,
    kind: parsed.kind,
    ...(parsed.kind === "cloud" && parsed.id.startsWith("cloud:")
      ? { cloudAgentId: parsed.id.slice("cloud:".length) }
      : {}),
    ...(parsed.kind === "cloud" && parsed.cloudRuntimeAgentId
      ? { cloudRuntimeAgentId: parsed.cloudRuntimeAgentId }
      : {}),
    ...(parsed.kind === "cloud" && parsed.cloudRuntime
      ? { cloudRuntime: parsed.cloudRuntime }
      : {}),
    apiBase: parsed.apiBase,
    accessToken: parsed.accessToken,
    credentialRef: parsed.credentialRef,
    createdAt: new Date().toISOString(),
  };

  const registry: AgentProfileRegistry = {
    version: 1,
    activeProfileId: profile.id,
    profiles: [profile],
  };

  // Persist immediately so migration only runs once.
  shellLocalStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  // Leave elizaos:active-server intact for rollback.
  return registry;
}

/* ── Public API ──────────────────────────────────────────────────────── */

export function loadAgentProfileRegistry(): AgentProfileRegistry {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as AgentProfileRegistry;
      if (parsed?.version === 1 && Array.isArray(parsed.profiles)) {
        return parsed;
      }
    }
    // No registry yet — try migrating from legacy single-server entry.
    return migrateFromPersistedActiveServer() ?? emptyRegistry();
  }, emptyRegistry());
}

export function saveAgentProfileRegistry(
  registry: AgentProfileRegistry,
): boolean {
  try {
    shellLocalStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
    return true;
  } catch (cause) {
    // error-policy:J1 localStorage boundary returns a visible failure signal to
    // connection-switch callers instead of fabricating a successful write.
    logger.warn(
      `[agent-profiles] failed to save registry: ${describePersistenceError(cause)}`,
    );
    return false;
  }
}

/**
 * Resolve a free-text switch query (from the AGENT_SWITCH action / `shell:
 * switch-agent` WS event) to a saved profile: exact id, then exact label
 * (case-insensitive), then a unique label substring match, then a unique
 * kind match ("cloud"/"local"/"remote"). Returns null when nothing matches or
 * a substring/kind is ambiguous — the caller reports "not-found" rather than
 * switching to the wrong agent.
 */
export function resolveAgentProfileByQuery(
  query: string,
  registry: AgentProfileRegistry = loadAgentProfileRegistry(),
): AgentProfile | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const profiles = registry.profiles;

  const byId = profiles.find((p) => p.id.toLowerCase() === q);
  if (byId) return byId;

  const byLabel = profiles.find((p) => p.label.trim().toLowerCase() === q);
  if (byLabel) return byLabel;

  const bySubstring = profiles.filter((p) =>
    p.label.trim().toLowerCase().includes(q),
  );
  if (bySubstring.length === 1) return bySubstring[0];

  if (q === "local" || q === "cloud" || q === "remote") {
    const byKind = profiles.filter((p) => p.kind === q);
    if (byKind.length === 1) return byKind[0];
  }

  return null;
}

export function getActiveProfile(): AgentProfile | null {
  const registry = loadAgentProfileRegistry();
  if (!registry.activeProfileId) return null;
  return (
    registry.profiles.find((p) => p.id === registry.activeProfileId) ?? null
  );
}

export function setActiveProfileId(id: string): boolean {
  const registry = loadAgentProfileRegistry();
  if (!registry.profiles.some((p) => p.id === id)) return false;
  registry.activeProfileId = id;
  return saveAgentProfileRegistry(registry);
}

/**
 * Persist both records that define a runtime selection before the live client
 * moves. The profile registry is written first because the active-server record
 * is the boot authority; if that second write fails, the unchanged server still
 * controls reload and the registry rollback keeps the runtime picker aligned
 * whenever storage accepts the compensating write.
 */
export function persistAgentProfileSelection(
  profileId: string,
  server: PersistedActiveServer,
): boolean {
  const registry = loadAgentProfileRegistry();
  if (!registry.profiles.some((profile) => profile.id === profileId)) {
    return false;
  }

  const nextRegistry: AgentProfileRegistry = {
    ...registry,
    activeProfileId: profileId,
  };
  if (!saveAgentProfileRegistry(nextRegistry)) return false;
  if (savePersistedActiveServer(server)) return true;

  if (!saveAgentProfileRegistry(registry)) {
    logger.error(
      "[agent-profiles] failed to roll back active profile after active-server persistence failed",
    );
  }
  return false;
}

export function addAgentProfile(
  profile: Omit<AgentProfile, "id" | "createdAt">,
  options: { activate?: boolean } = {},
): AgentProfile {
  const registry = loadAgentProfileRegistry();
  const full: AgentProfile = {
    ...profile,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  registry.profiles.push(full);
  if (options.activate !== false) registry.activeProfileId = full.id;
  saveAgentProfileRegistry(registry);
  return full;
}

/** Trailing-slash-insensitive apiBase compare (both sides may be normalized differently). */
function sameApiBase(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => (v ?? "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Explicit Cloud owner ids outrank transport addresses: one managed adapter
 * URL must never collapse two owners into a single credential-bearing row.
 * An older unbound row may match an incoming bound profile so the
 * authoritative upsert enriches it; a bound row never accepts unbound input.
 */
function sameProfileIdentity(
  stored: AgentProfile,
  incoming: Omit<AgentProfile, "id" | "createdAt">,
): boolean {
  if (stored.kind !== incoming.kind) return false;
  if (stored.kind === "cloud" && incoming.kind === "cloud") {
    if (stored.cloudAgentId && incoming.cloudAgentId) {
      return stored.cloudAgentId === incoming.cloudAgentId;
    }
    if (stored.cloudAgentId && !incoming.cloudAgentId) return false;
  }
  return sameApiBase(stored.apiBase, incoming.apiBase);
}

/**
 * Idempotently record + activate a connection in the profile registry so every
 * runtime-switch surface ("My Runtimes", Settings) stays truthful. Bound Cloud
 * profiles match by owner; other profiles retain the kind/base match so an
 * authoritative Cloud reconnect can enrich an older unbound row. Matching
 * profiles are re-activated and refreshed; otherwise a new profile is added.
 */
export function upsertAndActivateAgentProfile(
  profile: Omit<AgentProfile, "id" | "createdAt">,
): AgentProfile {
  const registry = loadAgentProfileRegistry();
  const existingIdx = registry.profiles.findIndex((stored) =>
    sameProfileIdentity(stored, profile),
  );
  if (existingIdx === -1) return addAgentProfile(profile);
  const merged: AgentProfile = {
    ...registry.profiles[existingIdx],
    label: profile.label || registry.profiles[existingIdx].label,
    ...(profile.cloudAgentId ? { cloudAgentId: profile.cloudAgentId } : {}),
    ...(profile.cloudRuntimeAgentId
      ? { cloudRuntimeAgentId: profile.cloudRuntimeAgentId }
      : {}),
    ...(profile.cloudRuntime ? { cloudRuntime: profile.cloudRuntime } : {}),
    ...(profile.apiBase !== undefined ? { apiBase: profile.apiBase } : {}),
    // A fresh token supersedes a stale one; an absent token leaves the prior in
    // place (a re-activate that carries no new token must not blank it out).
    ...(profile.accessToken ? { accessToken: profile.accessToken } : {}),
    ...(profile.credentialRef ? { credentialRef: profile.credentialRef } : {}),
  };
  registry.profiles[existingIdx] = merged;
  registry.activeProfileId = merged.id;
  saveAgentProfileRegistry(registry);
  return merged;
}

/** Preserve a cloud agent's platform identity when a profile becomes active. */
export function activeServerIdForAgentProfile(profile: AgentProfile): string {
  return profile.kind === "cloud" && profile.cloudAgentId
    ? `cloud:${profile.cloudAgentId}`
    : profile.id;
}

/** Remove every profile owned by the ending shared Cloud account session. */
export function removeManagedSharedCloudAgentProfiles(): void {
  const registry = loadAgentProfileRegistry();
  const profiles = registry.profiles.filter(
    (profile) => !isManagedCloudSharedAgentBase(profile.apiBase),
  );
  if (profiles.length === registry.profiles.length) return;
  const activeStillPresent = profiles.some(
    (profile) => profile.id === registry.activeProfileId,
  );
  saveAgentProfileRegistry({
    version: 1,
    activeProfileId: activeStillPresent ? registry.activeProfileId : null,
    profiles,
  });
}

export function removeAgentProfile(id: string): void {
  const registry = loadAgentProfileRegistry();
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  if (registry.activeProfileId === id) {
    registry.activeProfileId = registry.profiles[0]?.id ?? null;
  }
  saveAgentProfileRegistry(registry);
}

/**
 * Drop the bearer access token from every persisted agent profile while keeping
 * the rest of each profile (label/kind/apiBase/active selection). Call this on
 * sign-out: the token is a JWT and leaving copies in localStorage after sign-out
 * is an at-rest leak, but clearing the whole registry would needlessly forget
 * which backends to re-authenticate against.
 */
export function scrubPersistedAgentProfileTokens(): void {
  const registry = loadAgentProfileRegistry();
  let changed = false;
  registry.profiles = registry.profiles.map((profile) => {
    if (!profile.accessToken) return profile;
    changed = true;
    const { accessToken, ...rest } = profile;
    return rest;
  });
  if (changed) saveAgentProfileRegistry(registry);
}

export function updateAgentProfile(
  id: string,
  updates: Partial<Omit<AgentProfile, "id" | "createdAt">>,
): void {
  const registry = loadAgentProfileRegistry();
  const idx = registry.profiles.findIndex((p) => p.id === id);
  if (idx === -1) return;
  registry.profiles[idx] = { ...registry.profiles[idx], ...updates };
  saveAgentProfileRegistry(registry);
}

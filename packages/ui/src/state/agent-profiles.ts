/**
 * Multi-agent profile registry.
 *
 * Stores a catalogue of known agent connections (local, cloud, remote) in
 * localStorage so users can manage and switch between multiple agents.
 */

import { shellLocalStorage } from "../surface-realm-channel";
import type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";
import type { PersistedActiveServer } from "./persistence";

export type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";

/* ── Helpers ─────────────────────────────────────────────────────────── */

const STORAGE_KEY = "elizaos:agent-profiles";
const ACTIVE_SERVER_KEY = "elizaos:active-server";

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
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
    apiBase: parsed.apiBase,
    accessToken: parsed.accessToken,
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

export function saveAgentProfileRegistry(registry: AgentProfileRegistry): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  }, undefined);
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

export function setActiveProfileId(id: string): void {
  const registry = loadAgentProfileRegistry();
  if (!registry.profiles.some((p) => p.id === id)) return;
  registry.activeProfileId = id;
  saveAgentProfileRegistry(registry);
}

export function addAgentProfile(
  profile: Omit<AgentProfile, "id" | "createdAt">,
): AgentProfile {
  const registry = loadAgentProfileRegistry();
  const full: AgentProfile = {
    ...profile,
    id: generateId(),
    createdAt: new Date().toISOString(),
  };
  registry.profiles.push(full);
  registry.activeProfileId = full.id;
  saveAgentProfileRegistry(registry);
  return full;
}

/** Trailing-slash-insensitive apiBase compare (both sides may be normalized differently). */
function sameApiBase(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => (v ?? "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Idempotently record + activate a connection in the profile registry so every
 * runtime-switch surface ("My Runtimes", Settings) stays truthful. If a profile
 * for the same (kind, apiBase) already exists it is re-activated and its
 * token/label refreshed — reconnecting to the same host never creates a
 * duplicate. Otherwise a new profile is added (and activated). This is the
 * single seam the shared launch path (remote connect, cloud launch-session,
 * cloud-agent bind) routes through so a connection made anywhere shows up
 * everywhere with the correct Active badge.
 */
export function upsertAndActivateAgentProfile(
  profile: Omit<AgentProfile, "id" | "createdAt">,
): AgentProfile {
  const registry = loadAgentProfileRegistry();
  const existingIdx = registry.profiles.findIndex(
    (p) => p.kind === profile.kind && sameApiBase(p.apiBase, profile.apiBase),
  );
  if (existingIdx === -1) return addAgentProfile(profile);
  const merged: AgentProfile = {
    ...registry.profiles[existingIdx],
    label: profile.label || registry.profiles[existingIdx].label,
    ...(profile.apiBase !== undefined ? { apiBase: profile.apiBase } : {}),
    // A fresh token supersedes a stale one; an absent token leaves the prior in
    // place (a re-activate that carries no new token must not blank it out).
    ...(profile.accessToken ? { accessToken: profile.accessToken } : {}),
  };
  registry.profiles[existingIdx] = merged;
  registry.activeProfileId = merged.id;
  saveAgentProfileRegistry(registry);
  return merged;
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

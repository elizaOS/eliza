/**
 * Multi-agent profile registry.
 *
 * Stores a catalogue of known agent connections (local, cloud, remote) in
 * localStorage so users can manage and switch between multiple agents.
 */

import type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";
import type { PersistedActiveServer } from "./persistence";

export type { AgentProfile, AgentProfileRegistry } from "./agent-profile-types";

/* ── Helpers ─────────────────────────────────────────────────────────── */

const STORAGE_KEY = "elizaos:agent-profiles";
const ACTIVE_SERVER_KEY = "elizaos:active-server";

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.warn("[agent-profiles] localStorage operation failed:", err);
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  }, undefined);
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

export function removeAgentProfile(id: string): void {
  const registry = loadAgentProfileRegistry();
  registry.profiles = registry.profiles.filter((p) => p.id !== id);
  if (registry.activeProfileId === id) {
    registry.activeProfileId = registry.profiles[0]?.id ?? null;
  }
  saveAgentProfileRegistry(registry);
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

/** Keeps live configuration references aligned with committed durable state. */
import type { ElizaConfig } from "@elizaos/host/protocol";
import { resolveConfigWritePath } from "../config/config.ts";

/** Replace a live config in place so references held by callers stay valid. */
export function replaceConfigInPlace(
  state: ElizaConfig,
  next: ElizaConfig,
): void {
  const stateRecord = state as ElizaConfig & Record<string, unknown>;
  const nextRecord = next as ElizaConfig & Record<string, unknown>;
  for (const key of Object.keys(stateRecord)) {
    if (!(key in nextRecord)) {
      delete stateRecord[key];
    }
  }
  for (const [key, value] of Object.entries(nextRecord)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    stateRecord[key] = value;
  }
}

const liveConfigSources = new Map<string, Set<() => ElizaConfig>>();

/**
 * The API server registers its in-memory config here. Writers outside the
 * routes (chat actions, character persistence) save straight to disk; the
 * next route save writes the in-memory copy, so they must mirror into it.
 * Bind each reader to its persisted config path. Multiple servers reading the
 * same file stay aligned; independent host/config owners remain isolated.
 */
export function setLiveElizaConfigSource(
  read: () => ElizaConfig,
  configPath = resolveConfigWritePath(),
): () => void {
  let sources = liveConfigSources.get(configPath);
  if (!sources) {
    sources = new Set();
    liveConfigSources.set(configPath, sources);
  }
  sources.add(read);
  return () => {
    sources.delete(read);
    if (sources.size === 0 && liveConfigSources.get(configPath) === sources) {
      liveConfigSources.delete(configPath);
    }
  };
}

/** Mirror a config just written with saveElizaConfig into the live copy. */
export function mirrorSavedConfigToLive(saved: ElizaConfig): void {
  for (const read of liveConfigSources.get(resolveConfigWritePath()) ?? []) {
    const live = read();
    if (live !== saved) replaceConfigInPlace(live, structuredClone(saved));
  }
}

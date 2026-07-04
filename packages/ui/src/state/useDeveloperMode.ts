/**
 * Developer-mode toggle store (localStorage-backed): gates developer-only apps,
 * widgets, tabs, and settings. Off by default on every build; the user's choice
 * wins.
 */
import { useSyncExternalStore } from "react";

/**
 * Developer Mode state — when on, the shell renders apps, widgets, nav tabs,
 * and settings marked `developerOnly: true` (logs viewer, trajectory viewer,
 * raw config, etc). Persists to localStorage so it survives reloads.
 *
 * Default: OFF on every build — dev and production alike. There is no
 * `import.meta.env.DEV` bypass: a developer running `bun run dev` sees exactly
 * the launcher a user sees until they flip Settings → Advanced → "Developer
 * views". Once set, the user's explicit choice wins on every platform/build.
 */

const STORAGE_KEY = "eliza:developerMode";
const ENABLED = "1";
const DISABLED = "0";

const listeners = new Set<() => void>();

/** Default when the user hasn't chosen: always off, on every build. */
function defaultDeveloperMode(): boolean {
  return false;
}

function readStorage(): boolean {
  if (typeof window === "undefined") return defaultDeveloperMode();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === ENABLED) return true;
    if (raw === DISABLED) return false;
    return defaultDeveloperMode();
  } catch {
    return defaultDeveloperMode();
  }
}

/**
 * Cached snapshot of the persisted value. `getSnapshot` runs on every render of
 * every subscriber, so it must return a stable primitive without per-render
 * localStorage I/O. The cache is seeded once and refreshed only when the value
 * changes (via `setDeveloperMode` or a cross-tab `storage` event).
 */
let cachedEnabled = readStorage();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    const next = readStorage();
    if (next === cachedEnabled) return;
    cachedEnabled = next;
    for (const listener of listeners) {
      listener();
    }
  });
}

function writeStorage(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? ENABLED : DISABLED);
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — fall through.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return cachedEnabled;
}

function getServerSnapshot(): boolean {
  return false;
}

export function isDeveloperModeEnabled(): boolean {
  return cachedEnabled;
}

export function setDeveloperMode(enabled: boolean): void {
  writeStorage(enabled);
  if (enabled === cachedEnabled) return;
  cachedEnabled = enabled;
  for (const listener of listeners) {
    listener();
  }
}

export function useIsDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

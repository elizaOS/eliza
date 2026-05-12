import { useSyncExternalStore } from "react";

/**
 * Developer Mode state — when on, the shell renders apps, widgets, and
 * nav tabs marked `developerOnly: true` (logs viewer, trajectory viewer,
 * etc). Persists to localStorage so it survives reloads.
 */

const STORAGE_KEY = "eliza:developerMode";
const ENABLED = "1";
const DISABLED = "0";

const listeners = new Set<() => void>();

function readStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === ENABLED;
  } catch {
    return false;
  }
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
  return readStorage();
}

function getServerSnapshot(): boolean {
  return false;
}

export function isDeveloperModeEnabled(): boolean {
  return readStorage();
}

export function setDeveloperMode(enabled: boolean): void {
  writeStorage(enabled);
  for (const listener of listeners) {
    listener();
  }
}

export function useIsDeveloperMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

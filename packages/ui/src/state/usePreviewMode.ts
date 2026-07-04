/**
 * Preview-mode toggle store (localStorage-backed): gates preview/alpha views.
 * Always opt-in; mirrors useDeveloperMode apart from its default.
 */
import { useSyncExternalStore } from "react";

/**
 * Preview Mode state — when on, the shell renders apps, widgets, nav tabs, and
 * settings categorized as `preview` (unfinished / alpha / experimental views).
 * Persists to localStorage so it survives reloads.
 *
 * Default: OFF on every build (dev and production alike). Preview views are
 * always opt-in — unlike Developer Mode, they are never enabled by the build.
 * The user's explicit choice (once made) wins on every platform/build.
 *
 * Mirrors {@link ./useDeveloperMode} so the two toggles behave identically
 * apart from their default.
 */

const STORAGE_KEY = "eliza:previewMode";
const ENABLED = "1";
const DISABLED = "0";

const listeners = new Set<() => void>();

/** Build-default when the user hasn't chosen: always off. */
function defaultPreviewMode(): boolean {
  return false;
}

function readStorage(): boolean {
  if (typeof window === "undefined") return defaultPreviewMode();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === ENABLED) return true;
    if (raw === DISABLED) return false;
    return defaultPreviewMode();
  } catch {
    return defaultPreviewMode();
  }
}

/**
 * Cached snapshot of the persisted value. `getSnapshot` runs on every render of
 * every subscriber, so it must return a stable primitive without per-render
 * localStorage I/O. The cache is seeded once and refreshed only when the value
 * changes (via `setPreviewMode` or a cross-tab `storage` event).
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

export function isPreviewModeEnabled(): boolean {
  return cachedEnabled;
}

export function setPreviewMode(enabled: boolean): void {
  writeStorage(enabled);
  if (enabled === cachedEnabled) return;
  cachedEnabled = enabled;
  for (const listener of listeners) {
    listener();
  }
}

export function useIsPreviewMode(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

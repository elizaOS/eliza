/**
 * Storage Bridge
 *
 * This module provides a bridge between the web UI's localStorage usage
 * and Capacitor's Preferences plugin for native platforms. On web, it
 * passes through to localStorage. On native, it uses Preferences for
 * more reliable persistence.
 *
 * The bridge works by intercepting localStorage calls via a proxy and
 * syncing with Capacitor Preferences on native platforms.
 */

import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

const isNative = Capacitor.isNativePlatform();

// Keys that should be synced to Capacitor Preferences
const SYNCED_KEYS = new Set([
  "milaidy.control.settings.v1",
  "milaidy.device.identity",
  "milaidy.device.auth",
]);

// In-memory cache of values from Preferences (for native)
const preferencesCache = new Map<string, string>();

// Flag to track if initial sync has completed
let initialized = false;

/**
 * Initialize the storage bridge
 *
 * On native platforms, this loads values from Capacitor Preferences
 * into the in-memory cache and optionally syncs them to localStorage.
 */
export async function initializeStorageBridge(): Promise<void> {
  if (!isNative) {
    initialized = true;
    return;
  }

  // Load all synced keys from Preferences into cache
  for (const key of SYNCED_KEYS) {
    const result = await Preferences.get({ key });
    if (result.value !== null) {
      preferencesCache.set(key, result.value);
      // Also set in localStorage for immediate availability
      try {
        window.localStorage.setItem(key, result.value);
      } catch {
        // localStorage might fail in some contexts
      }
    }
  }

  // Set up the storage proxy
  setupStorageProxy();

  initialized = true;
}

/**
 * Set up a proxy to intercept localStorage operations
 */
function setupStorageProxy(): void {
  if (!isNative) {
    return;
  }

  const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
  const originalGetItem = window.localStorage.getItem.bind(window.localStorage);
  const originalRemoveItem = window.localStorage.removeItem.bind(window.localStorage);

  // Override setItem
  window.localStorage.setItem = (key: string, value: string): void => {
    // Always set in localStorage first
    originalSetItem(key, value);

    // If it's a synced key, also persist to Preferences
    if (SYNCED_KEYS.has(key)) {
      preferencesCache.set(key, value);
      // Fire and forget - we don't wait for this
      Preferences.set({ key, value }).catch((err) => {
        console.error(`[Storage Bridge] Failed to persist ${key}:`, err);
      });
    }
  };

  // Override getItem
  window.localStorage.getItem = (key: string): string | null => {
    // For synced keys, prefer the cache (which was loaded from Preferences)
    if (SYNCED_KEYS.has(key) && preferencesCache.has(key)) {
      return preferencesCache.get(key) ?? null;
    }
    return originalGetItem(key);
  };

  // Override removeItem
  window.localStorage.removeItem = (key: string): void => {
    originalRemoveItem(key);

    if (SYNCED_KEYS.has(key)) {
      preferencesCache.delete(key);
      Preferences.remove({ key }).catch((err) => {
        console.error(`[Storage Bridge] Failed to remove ${key}:`, err);
      });
    }
  };
}

/**
 * Get a value from storage (works on both native and web)
 */
export async function getStorageValue(key: string): Promise<string | null> {
  if (isNative && SYNCED_KEYS.has(key)) {
    const result = await Preferences.get({ key });
    return result.value;
  }
  return window.localStorage.getItem(key);
}

/**
 * Set a value in storage (works on both native and web)
 */
export async function setStorageValue(key: string, value: string): Promise<void> {
  window.localStorage.setItem(key, value);

  if (isNative && SYNCED_KEYS.has(key)) {
    await Preferences.set({ key, value });
  }
}

/**
 * Remove a value from storage (works on both native and web)
 */
export async function removeStorageValue(key: string): Promise<void> {
  window.localStorage.removeItem(key);

  if (isNative && SYNCED_KEYS.has(key)) {
    await Preferences.remove({ key });
  }
}

/**
 * Register additional keys to be synced to Preferences
 */
export function registerSyncedKey(key: string): void {
  SYNCED_KEYS.add(key);
}

/**
 * Check if storage bridge is initialized
 */
export function isStorageBridgeInitialized(): boolean {
  return initialized;
}

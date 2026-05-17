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
/**
 * Initialize the storage bridge
 *
 * On native platforms, this loads values from Capacitor Preferences
 * into the in-memory cache and optionally syncs them to localStorage.
 */
export declare function initializeStorageBridge(): Promise<void>;
/**
 * Get a value from storage (works on both native and web)
 */
export declare function getStorageValue(key: string): Promise<string | null>;
/**
 * Set a value in storage (works on both native and web)
 */
export declare function setStorageValue(key: string, value: string): Promise<void>;
/**
 * Remove a value from storage (works on both native and web)
 */
export declare function removeStorageValue(key: string): Promise<void>;
/**
 * Register additional keys to be synced to Preferences
 */
export declare function registerSyncedKey(key: string): void;
/**
 * Check if storage bridge is initialized
 */
export declare function isStorageBridgeInitialized(): boolean;
//# sourceMappingURL=storage-bridge.d.ts.map
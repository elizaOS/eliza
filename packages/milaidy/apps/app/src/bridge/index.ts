/**
 * Capacitor Bridge Module
 *
 * This module exports all bridge utilities for use by the app and plugins.
 */

export {
  initializeCapacitorBridge,
  getCapabilities,
  haptics,
  registerPlugin,
  getPlugin,
  hasPlugin,
  waitForBridge,
  type MilaidyBridge,
  type CapacitorCapabilities,
} from "./capacitor-bridge.js";

export {
  initializeStorageBridge,
  getStorageValue,
  setStorageValue,
  removeStorageValue,
  registerSyncedKey,
  isStorageBridgeInitialized,
} from "./storage-bridge.js";

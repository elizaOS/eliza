/**
 * Capacitor Bridge
 *
 * This module provides a bridge between the web UI and native
 * Capacitor plugins. It exposes a global API that the UI can use to
 * access native capabilities like camera, microphone, file system, etc.
 *
 * The bridge is designed to be progressively enhanced - features are
 * only available when running on platforms that support them.
 */

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { BRIDGE_READY_EVENT, dispatchAppEvent } from "../events";
import { isElectrobunRuntime } from "./electrobun-runtime";

// Import the plugin bridge
import {
  type ElizaPlugins,
  getPluginCapabilities,
  getPlugins,
  isFeatureAvailable,
  type PluginCapabilities,
} from "./plugin-bridge";

// Platform detection
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

function isWebPlatform(): boolean {
  return platform === "web" && !isElectrobunRuntime();
}

/**
 * Capability flags indicating what features are available
 */
export interface CapacitorCapabilities {
  /** Whether we're running in a native container */
  native: boolean;
  /** Platform identifier */
  platform: "ios" | "android" | "electrobun" | "web";
  /** Haptic feedback support */
  haptics: boolean;
  /** Camera capture support */
  camera: boolean;
  /** Microphone/audio capture support */
  microphone: boolean;
  /** Screen recording support */
  screenCapture: boolean;
  /** File system access */
  fileSystem: boolean;
  /** Push notifications */
  notifications: boolean;
  /** Geolocation */
  geolocation: boolean;
  /** Background execution */
  background: boolean;
  /** Voice wake/always-on listening */
  voiceWake: boolean;
}

/**
 * Get the current platform capabilities
 */
export function getCapabilities(): CapacitorCapabilities {
  const isDesktop = isDesktopPlatform();
  return {
    native: isNative,
    platform: (isDesktop
      ? "electrobun"
      : platform) as CapacitorCapabilities["platform"],
    haptics: isNative && (isIOS || isAndroid),
    camera: isNative,
    microphone: isNative,
    screenCapture: isNative && !isDesktop, // Desktop uses a separate capture path
    fileSystem: isNative,
    notifications: isNative,
    geolocation: true, // Available on web too via browser API
    background: isNative && !isDesktop,
    voiceWake: isNative && (isIOS || isAndroid), // macOS via Swabble handled separately
  };
}

/**
 * Haptic feedback wrapper
 */
export const haptics = {
  /**
   * Trigger a light impact haptic (for UI interactions)
   */
  async light(): Promise<void> {
    if (!isNative) return;
    await Haptics.impact({ style: ImpactStyle.Light });
  },

  /**
   * Trigger a medium impact haptic (for confirmations)
   */
  async medium(): Promise<void> {
    if (!isNative) return;
    await Haptics.impact({ style: ImpactStyle.Medium });
  },

  /**
   * Trigger a heavy impact haptic (for important actions)
   */
  async heavy(): Promise<void> {
    if (!isNative) return;
    await Haptics.impact({ style: ImpactStyle.Heavy });
  },

  /**
   * Trigger a success notification haptic
   */
  async success(): Promise<void> {
    if (!isNative) return;
    await Haptics.notification({ type: NotificationType.Success });
  },

  /**
   * Trigger a warning notification haptic
   */
  async warning(): Promise<void> {
    if (!isNative) return;
    await Haptics.notification({ type: NotificationType.Warning });
  },

  /**
   * Trigger an error notification haptic
   */
  async error(): Promise<void> {
    if (!isNative) return;
    await Haptics.notification({ type: NotificationType.Error });
  },

  /**
   * Start a selection change haptic (for pickers)
   */
  async selectionStart(): Promise<void> {
    if (!isNative) return;
    await Haptics.selectionStart();
  },

  /**
   * Trigger selection changed haptic
   */
  async selectionChanged(): Promise<void> {
    if (!isNative) return;
    await Haptics.selectionChanged();
  },

  /**
   * End selection change haptic
   */
  async selectionEnd(): Promise<void> {
    if (!isNative) return;
    await Haptics.selectionEnd();
  },
};

/**
 * Plugin registry for custom native plugins
 *
 * Custom plugins (Gateway, Swabble, Canvas, etc.) will register themselves here
 * when they're loaded. This allows the UI to check for plugin availability
 * and access them in a type-safe way.
 */
type PluginInstance = Record<string, unknown>;
const pluginRegistry = new Map<string, PluginInstance>();

/**
 * Register a custom plugin
 */
export function registerPlugin(name: string, plugin: PluginInstance): void {
  pluginRegistry.set(name, plugin);
  console.log(`[Capacitor Bridge] Registered plugin: ${name}`);
}

/**
 * Get a registered plugin
 */
export function getPlugin<T extends PluginInstance>(
  name: string,
): T | undefined {
  return pluginRegistry.get(name) as T | undefined;
}

/**
 * Check if a plugin is registered
 */
export function hasPlugin(name: string): boolean {
  return pluginRegistry.has(name);
}

/**
 * The global native bridge object exposed to the UI
 */
export interface ElizaBridge {
  /** Platform capabilities */
  capabilities: CapacitorCapabilities;
  /** Plugin-specific capabilities */
  pluginCapabilities: PluginCapabilities;
  /** Haptic feedback */
  haptics: typeof haptics;
  /** Get a registered plugin */
  getPlugin: typeof getPlugin;
  /** Check if a plugin exists */
  hasPlugin: typeof hasPlugin;
  /** Register a new plugin */
  registerPlugin: typeof registerPlugin;
  /** Get all native plugins with fallback support */
  plugins: ElizaPlugins;
  /** Check if a specific feature is available */
  isFeatureAvailable: typeof isFeatureAvailable;
  /** Platform info */
  platform: {
    name: string;
    isNative: boolean;
    isIOS: boolean;
    isAndroid: boolean;
    isDesktop: boolean;
    isWeb: boolean;
    isMacOS: boolean;
  };
}

/**
 * Create the global bridge object
 */
function createBridge(): ElizaBridge {
  const isDesktop = isDesktopPlatform();
  return {
    capabilities: getCapabilities(),
    pluginCapabilities: getPluginCapabilities(),
    haptics,
    getPlugin,
    hasPlugin,
    registerPlugin,
    plugins: getPlugins(),
    isFeatureAvailable,
    platform: {
      name: platform,
      isNative,
      isIOS,
      isAndroid,
      isDesktop,
      isWeb: isWebPlatform(),
      isMacOS: isDesktop, // Electrobun is used for macOS/desktop
    },
  };
}

// Extend the Window interface to include our bridge
declare global {
  interface Window {
    Eliza: ElizaBridge;
  }
}

/**
 * Initialize the Capacitor bridge
 *
 * This exposes the bridge object on window.Eliza for use by the UI.
 */
export function initializeCapacitorBridge(): void {
  window.Eliza = createBridge();

  // Dispatch an event to notify that the bridge is ready
  dispatchAppEvent(BRIDGE_READY_EVENT, window.Eliza);
}

/**
 * Wait for the bridge to be ready
 *
 * Returns immediately if already initialized, otherwise waits for the event.
 */
export function waitForBridge(): Promise<ElizaBridge> {
  if (window.Eliza) {
    return Promise.resolve(window.Eliza);
  }

  return new Promise((resolve) => {
    document.addEventListener(
      BRIDGE_READY_EVENT,
      (event) => {
        resolve((event as CustomEvent<ElizaBridge>).detail);
      },
      { once: true },
    );
  });
}

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
import { type ElizaPlugins, isFeatureAvailable, type PluginCapabilities } from "./plugin-bridge";
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
export declare function getCapabilities(): CapacitorCapabilities;
/**
 * Haptic feedback wrapper
 */
export declare const haptics: {
    /**
     * Trigger a light impact haptic (for UI interactions)
     */
    light(): Promise<void>;
    /**
     * Trigger a medium impact haptic (for confirmations)
     */
    medium(): Promise<void>;
    /**
     * Trigger a heavy impact haptic (for important actions)
     */
    heavy(): Promise<void>;
    /**
     * Trigger a success notification haptic
     */
    success(): Promise<void>;
    /**
     * Trigger a warning notification haptic
     */
    warning(): Promise<void>;
    /**
     * Trigger an error notification haptic
     */
    error(): Promise<void>;
    /**
     * Start a selection change haptic (for pickers)
     */
    selectionStart(): Promise<void>;
    /**
     * Trigger selection changed haptic
     */
    selectionChanged(): Promise<void>;
    /**
     * End selection change haptic
     */
    selectionEnd(): Promise<void>;
};
/**
 * Plugin registry for custom native plugins
 *
 * Custom plugins (Gateway, Swabble, Canvas, etc.) will register themselves here
 * when they're loaded. This allows the UI to check for plugin availability
 * and access them in a type-safe way.
 */
type PluginInstance = Record<string, unknown>;
/**
 * Register a custom plugin
 */
export declare function registerPlugin(name: string, plugin: PluginInstance): void;
/**
 * Get a registered plugin
 */
export declare function getPlugin<T extends PluginInstance>(name: string): T | undefined;
/**
 * Check if a plugin is registered
 */
export declare function hasPlugin(name: string): boolean;
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
export declare function initializeCapacitorBridge(): void;
/**
 * Wait for the bridge to be ready
 *
 * Returns immediately if already initialized, otherwise waits for the event.
 */
export declare function waitForBridge(): Promise<ElizaBridge>;
export {};
//# sourceMappingURL=capacitor-bridge.d.ts.map
/**
 * Plugin Bridge
 *
 * This module provides a single interface to all Capacitor plugins
 * with platform-specific fallbacks and capability detection.
 *
 * When a native plugin is unavailable, it provides graceful degradation
 * to web APIs or stub implementations where possible.
 */
import { type ContactsPluginLike, type GenericNativePlugin, type MessagesPluginLike, type PhonePluginLike, type SwabblePluginLike, type SystemPluginLike, type TalkModePluginLike } from "./native-plugins";
/**
 * Plugin capability flags
 */
export interface PluginCapabilities {
    /** Gateway connection and discovery */
    gateway: {
        available: boolean;
        discovery: boolean;
        websocket: boolean;
    };
    /** Voice wake word detection */
    voiceWake: {
        available: boolean;
        continuous: boolean;
    };
    /** Talk mode (STT + chat + TTS) */
    talkMode: {
        available: boolean;
        elevenlabs: boolean;
        systemTts: boolean;
    };
    /** Camera capture */
    camera: {
        available: boolean;
        photo: boolean;
        video: boolean;
    };
    /** Location services */
    location: {
        available: boolean;
        gps: boolean;
        background: boolean;
    };
    /** Screen capture */
    screenCapture: {
        available: boolean;
        screenshot: boolean;
        recording: boolean;
    };
    /** Canvas rendering */
    canvas: {
        available: boolean;
    };
    /** Android phone stack */
    phone: {
        available: boolean;
    };
    /** Android contacts provider */
    contacts: {
        available: boolean;
    };
    /** Android SMS provider */
    messages: {
        available: boolean;
    };
    /** Android system role/status bridge */
    system: {
        available: boolean;
    };
    /** Desktop features (macOS/Electrobun) */
    desktop: {
        available: boolean;
        tray: boolean;
        shortcuts: boolean;
        menu: boolean;
    };
}
/**
 * Get plugin capabilities for the current platform
 */
export declare function getPluginCapabilities(): PluginCapabilities;
/**
 * Wrapped plugin with fallback behavior
 */
interface WrappedPlugin<T> {
    /** The plugin instance */
    plugin: T;
    /** Whether the native plugin is available */
    isNative: boolean;
    /** Whether the plugin has a web fallback */
    hasFallback: boolean;
}
/**
 * The plugin bridge providing access to all native plugins
 */
export interface ElizaPlugins {
    /** Gateway connection plugin */
    gateway: WrappedPlugin<GenericNativePlugin>;
    /** Voice wake word plugin */
    swabble: WrappedPlugin<SwabblePluginLike>;
    /** Talk mode plugin */
    talkMode: WrappedPlugin<TalkModePluginLike>;
    /** Camera plugin */
    camera: WrappedPlugin<GenericNativePlugin>;
    /** Location plugin */
    location: WrappedPlugin<GenericNativePlugin>;
    /** Screen capture plugin */
    screenCapture: WrappedPlugin<GenericNativePlugin>;
    /** Canvas plugin */
    canvas: WrappedPlugin<GenericNativePlugin>;
    /** Android phone plugin */
    phone: WrappedPlugin<PhonePluginLike>;
    /** Android contacts plugin */
    contacts: WrappedPlugin<ContactsPluginLike>;
    /** Android messages plugin */
    messages: WrappedPlugin<MessagesPluginLike>;
    /** Android system plugin */
    system: WrappedPlugin<SystemPluginLike>;
    /** Desktop plugin (macOS/Electrobun) */
    desktop: WrappedPlugin<GenericNativePlugin>;
    /** Plugin capabilities */
    capabilities: PluginCapabilities;
}
/**
 * Initialize and get the plugins interface
 */
export declare function getPlugins(): ElizaPlugins;
/**
 * Check if a specific plugin feature is available
 */
export declare function isFeatureAvailable(feature: "gatewayDiscovery" | "voiceWake" | "talkMode" | "elevenlabs" | "camera" | "location" | "backgroundLocation" | "screenCapture" | "phone" | "contacts" | "messages" | "system" | "desktopTray"): boolean;
export {};
//# sourceMappingURL=plugin-bridge.d.ts.map
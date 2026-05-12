/**
 * Plugin Bridge
 *
 * This module provides a single interface to all Capacitor plugins
 * with platform-specific fallbacks and capability detection.
 *
 * When a native plugin is unavailable, it provides graceful degradation
 * to web APIs or stub implementations where possible.
 */

import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "./electrobun-runtime";
import {
  type ContactsPluginLike,
  type GenericNativePlugin,
  getCameraPlugin,
  getCanvasPlugin,
  getContactsPlugin,
  getDesktopPlugin,
  getGatewayPlugin,
  getLocationPlugin,
  getMessagesPlugin,
  getPhonePlugin,
  getScreenCapturePlugin,
  getSwabblePlugin,
  getSystemPlugin,
  getTalkModePlugin,
  type MessagesPluginLike,
  type PhonePluginLike,
  type SwabblePluginLike,
  type SystemPluginLike,
  type TalkModePluginLike,
} from "./native-plugins";

// Platform detection
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const _isIOS = platform === "ios";
const _isAndroid = platform === "android";

function isDesktopPlatform(): boolean {
  return isElectrobunRuntime();
}

function _isWebPlatform(): boolean {
  return platform === "web" && !isElectrobunRuntime();
}

function _isMacOSPlatform(): boolean {
  return isDesktopPlatform();
}

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
export function getPluginCapabilities(): PluginCapabilities {
  const isDesktop = isDesktopPlatform();
  return {
    gateway: {
      available: true, // Web fallback available
      discovery: isNative, // Discovery requires native APIs
      websocket: true, // WebSocket available on all platforms
    },
    voiceWake: {
      available: isNative || hasWebSpeechAPI(),
      continuous: isNative, // Only native supports continuous listening
    },
    talkMode: {
      available: isNative || hasWebSpeechAPI(),
      elevenlabs: true, // Web app can call ElevenLabs directly with user API key
      systemTts: isNative || hasWebSpeechSynthesis(),
    },
    camera: {
      available: isNative || hasMediaDevices(),
      photo: isNative || hasMediaDevices(),
      video: isNative || hasMediaDevices(),
    },
    location: {
      available: hasGeolocation(),
      gps: isNative,
      background: isNative && !isDesktop,
    },
    screenCapture: {
      available: isNative || hasDisplayMedia(),
      screenshot: isNative,
      recording: isNative || hasDisplayMedia(),
    },
    canvas: {
      available: true, // HTML Canvas available on all platforms
    },
    phone: {
      available: isNative && platform === "android",
    },
    contacts: {
      available: isNative && platform === "android",
    },
    messages: {
      available: isNative && platform === "android",
    },
    system: {
      available: isNative && platform === "android",
    },
    desktop: {
      available: isDesktop,
      tray: isDesktop,
      shortcuts: isDesktop,
      menu: isDesktop,
    },
  };
}

// Web API detection helpers
function hasWebSpeechAPI(): boolean {
  return (
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
  );
}

function hasWebSpeechSynthesis(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function hasMediaDevices(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    "getUserMedia" in navigator.mediaDevices
  );
}

function hasGeolocation(): boolean {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

function hasDisplayMedia(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "mediaDevices" in navigator &&
    "getDisplayMedia" in navigator.mediaDevices
  );
}

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
 * Create a wrapped plugin with error handling
 */
function wrapPlugin<T extends Record<string, unknown>>(
  plugin: T,
  _name: string,
): T {
  return new Proxy(plugin, {
    get(target, prop) {
      const value = target[prop as keyof T];
      if (typeof value === "function") {
        return async (...args: unknown[]) => {
          try {
            return await (
              value as (...args: unknown[]) => Promise<unknown>
            ).apply(target, args);
          } catch (error) {
            console.error(`[Plugin Bridge] ${String(prop)} failed:`, error);
            throw error;
          }
        };
      }
      return value;
    },
  });
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

// Singleton instance
let pluginsInstance: ElizaPlugins | null = null;

/**
 * Initialize and get the plugins interface
 */
export function getPlugins(): ElizaPlugins {
  if (pluginsInstance) {
    if (pluginsInstance.desktop.isNative === isDesktopPlatform()) {
      return pluginsInstance;
    }
  }

  const capabilities = getPluginCapabilities();
  const isDesktop = isDesktopPlatform();

  pluginsInstance = {
    gateway: {
      plugin: wrapPlugin(getGatewayPlugin(), "Gateway"),
      isNative: isNative,
      hasFallback: true,
    },
    swabble: {
      plugin: wrapPlugin(getSwabblePlugin(), "Swabble"),
      isNative: isNative,
      hasFallback: capabilities.voiceWake.available,
    },
    talkMode: {
      plugin: wrapPlugin(getTalkModePlugin(), "TalkMode"),
      isNative: isNative,
      hasFallback: capabilities.talkMode.available,
    },
    camera: {
      plugin: wrapPlugin(getCameraPlugin(), "Camera"),
      isNative: isNative,
      hasFallback: capabilities.camera.available,
    },
    location: {
      plugin: wrapPlugin(getLocationPlugin(), "Location"),
      isNative: isNative,
      hasFallback: capabilities.location.available,
    },
    screenCapture: {
      plugin: wrapPlugin(getScreenCapturePlugin(), "ScreenCapture"),
      isNative: isNative,
      hasFallback: capabilities.screenCapture.available,
    },
    canvas: {
      plugin: wrapPlugin(getCanvasPlugin(), "Canvas"),
      isNative: isNative,
      hasFallback: true,
    },
    phone: {
      plugin: wrapPlugin(getPhonePlugin(), "ElizaPhone"),
      isNative: isNative,
      hasFallback: capabilities.phone.available,
    },
    contacts: {
      plugin: wrapPlugin(getContactsPlugin(), "ElizaContacts"),
      isNative: isNative,
      hasFallback: capabilities.contacts.available,
    },
    messages: {
      plugin: wrapPlugin(getMessagesPlugin(), "ElizaMessages"),
      isNative: isNative,
      hasFallback: capabilities.messages.available,
    },
    system: {
      plugin: wrapPlugin(getSystemPlugin(), "ElizaSystem"),
      isNative: isNative,
      hasFallback: capabilities.system.available,
    },
    desktop: {
      plugin: wrapPlugin(getDesktopPlugin(), "Desktop"),
      isNative: isDesktop,
      hasFallback: false,
    },
    capabilities,
  };

  return pluginsInstance;
}

/**
 * Check if a specific plugin feature is available
 */
export function isFeatureAvailable(
  feature:
    | "gatewayDiscovery"
    | "voiceWake"
    | "talkMode"
    | "elevenlabs"
    | "camera"
    | "location"
    | "backgroundLocation"
    | "screenCapture"
    | "phone"
    | "contacts"
    | "messages"
    | "system"
    | "desktopTray",
): boolean {
  const caps = getPluginCapabilities();

  switch (feature) {
    case "gatewayDiscovery":
      return caps.gateway.discovery;
    case "voiceWake":
      return caps.voiceWake.available;
    case "talkMode":
      return caps.talkMode.available;
    case "elevenlabs":
      return caps.talkMode.elevenlabs;
    case "camera":
      return caps.camera.available;
    case "location":
      return caps.location.available;
    case "backgroundLocation":
      return caps.location.background;
    case "screenCapture":
      return caps.screenCapture.available;
    case "phone":
      return caps.phone.available;
    case "contacts":
      return caps.contacts.available;
    case "messages":
      return caps.messages.available;
    case "system":
      return caps.system.available;
    case "desktopTray":
      return caps.desktop.tray;
    default:
      return false;
  }
}

/**
 * Desktop Plugin for Electron
 *
 * This module provides native desktop features for the Electron platform including:
 * - System tray management
 * - Global keyboard shortcuts
 * - Auto-launch on system startup
 * - Window management
 * - Native notifications
 * - Power monitoring
 * - Clipboard operations
 * - Shell operations
 *
 * This file should be loaded in the Electron main process and
 * its API exposed to the renderer via IPC.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  DesktopPlugin,
  TrayMenuItem,
  TrayOptions,
  TrayClickEvent,
  TrayMenuClickEvent,
  GlobalShortcut,
  GlobalShortcutEvent,
  AutoLaunchOptions,
  WindowOptions,
  WindowBounds,
  NotificationOptions,
  NotificationEvent,
  PowerMonitorState,
} from "../../src/definitions";

type DesktopEventPayloads = {
  trayClick: TrayClickEvent;
  trayDoubleClick: TrayClickEvent;
  trayRightClick: TrayClickEvent;
  trayMenuClick: TrayMenuClickEvent;
  shortcutPressed: GlobalShortcutEvent;
  notificationClick: NotificationEvent;
  notificationAction: NotificationEvent;
  notificationReply: NotificationEvent;
  windowFocus: void;
  windowBlur: void;
  windowMaximize: void;
  windowUnmaximize: void;
  windowMinimize: void;
  windowRestore: void;
  windowClose: void;
  powerSuspend: void;
  powerResume: void;
  powerOnAC: void;
  powerOnBattery: void;
};

type DesktopEventName = keyof DesktopEventPayloads;
type DesktopEventData = DesktopEventPayloads[DesktopEventName];
type EventCallback<T = DesktopEventData> = (event: T) => void;

interface ListenerEntry {
  eventName: DesktopEventName;
  callback: EventCallback;
}

type AlwaysOnTopLevel = Parameters<DesktopPlugin["setAlwaysOnTop"]>[0]["level"];
type DesktopPathName = Parameters<DesktopPlugin["getPath"]>[0]["name"];

// Type definitions for Electron APIs accessed via window
type IpcPrimitive = string | number | boolean | null | undefined;
type IpcObject = { [key: string]: IpcValue };
type IpcValue = IpcPrimitive | IpcObject | IpcValue[] | ArrayBuffer | Float32Array | Uint8Array;

interface ElectronAPI {
  ipcRenderer: {
    invoke(channel: string, ...args: IpcValue[]): Promise<IpcValue>;
    on(channel: string, listener: (...args: IpcValue[]) => void): void;
    removeListener(channel: string, listener: (...args: IpcValue[]) => void): void;
  };
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

/**
 * Helper to throw when Electron IPC is unavailable.
 * Desktop plugin features require Electron's main process access.
 */
function requireIPC(feature: string): never {
  throw new Error(
    `${feature} is not available: Electron IPC bridge not found. ` +
      "The Desktop plugin requires the Electron main process with properly configured IPC handlers."
  );
}

/**
 * Desktop Plugin implementation for Electron
 * Uses IPC to communicate with the main process
 */
export class DesktopElectron implements DesktopPlugin {
  private listeners: ListenerEntry[] = [];
  private ipcListeners: Map<DesktopEventName, (...args: IpcValue[]) => void> = new Map();

  constructor() {
    this.setupIPCListeners();
  }

  private get ipc(): ElectronAPI["ipcRenderer"] | undefined {
    return window.electron?.ipcRenderer;
  }

  /**
   * Ensures IPC is available, throws descriptive error if not
   */
  private requireIPC(feature: string): ElectronAPI["ipcRenderer"] {
    const ipc = this.ipc;
    if (!ipc) {
      requireIPC(feature);
    }
    return ipc;
  }

  private setupIPCListeners(): void {
    if (!this.ipc) return;

    const events: DesktopEventName[] = [
      "trayClick",
      "trayDoubleClick",
      "trayRightClick",
      "trayMenuClick",
      "shortcutPressed",
      "notificationClick",
      "notificationAction",
      "notificationReply",
      "windowFocus",
      "windowBlur",
      "windowMaximize",
      "windowUnmaximize",
      "windowMinimize",
      "windowRestore",
      "windowClose",
      "powerSuspend",
      "powerResume",
      "powerOnAC",
      "powerOnBattery",
    ];

    for (const eventName of events) {
      const handler = (...args: IpcValue[]) => {
        const data = args[0] as DesktopEventPayloads[typeof eventName];
        this.notifyListeners(eventName, data);
      };
      this.ipc.on(`desktop:${eventName}`, handler);
      this.ipcListeners.set(eventName, handler);
    }
  }

  // System Tray
  async createTray(options: TrayOptions): Promise<void> {
    const ipc = this.requireIPC("createTray");
    await ipc.invoke("desktop:createTray", options);
  }

  async updateTray(options: Partial<TrayOptions>): Promise<void> {
    const ipc = this.requireIPC("updateTray");
    await ipc.invoke("desktop:updateTray", options);
  }

  async destroyTray(): Promise<void> {
    const ipc = this.requireIPC("destroyTray");
    await ipc.invoke("desktop:destroyTray");
  }

  async setTrayMenu(options: { menu: TrayMenuItem[] }): Promise<void> {
    const ipc = this.requireIPC("setTrayMenu");
    await ipc.invoke("desktop:setTrayMenu", options);
  }

  // Global Shortcuts
  async registerShortcut(options: GlobalShortcut): Promise<{ success: boolean }> {
    const ipc = this.requireIPC("registerShortcut");
    return (await ipc.invoke("desktop:registerShortcut", options)) as { success: boolean };
  }

  async unregisterShortcut(options: { id: string }): Promise<void> {
    const ipc = this.requireIPC("unregisterShortcut");
    await ipc.invoke("desktop:unregisterShortcut", options);
  }

  async unregisterAllShortcuts(): Promise<void> {
    const ipc = this.requireIPC("unregisterAllShortcuts");
    await ipc.invoke("desktop:unregisterAllShortcuts");
  }

  async isShortcutRegistered(options: { accelerator: string }): Promise<{ registered: boolean }> {
    const ipc = this.requireIPC("isShortcutRegistered");
    return (await ipc.invoke("desktop:isShortcutRegistered", options)) as { registered: boolean };
  }

  // Auto Launch
  async setAutoLaunch(options: AutoLaunchOptions): Promise<void> {
    const ipc = this.requireIPC("setAutoLaunch");
    await ipc.invoke("desktop:setAutoLaunch", options);
  }

  async getAutoLaunchStatus(): Promise<{ enabled: boolean; openAsHidden: boolean }> {
    const ipc = this.requireIPC("getAutoLaunchStatus");
    return (await ipc.invoke("desktop:getAutoLaunchStatus")) as { enabled: boolean; openAsHidden: boolean };
  }

  // Window Management
  async setWindowOptions(options: WindowOptions): Promise<void> {
    const ipc = this.requireIPC("setWindowOptions");
    await ipc.invoke("desktop:setWindowOptions", options);
  }

  async getWindowBounds(): Promise<WindowBounds> {
    const ipc = this.requireIPC("getWindowBounds");
    return (await ipc.invoke("desktop:getWindowBounds")) as WindowBounds;
  }

  async setWindowBounds(options: WindowBounds): Promise<void> {
    const ipc = this.requireIPC("setWindowBounds");
    await ipc.invoke("desktop:setWindowBounds", options);
  }

  async minimizeWindow(): Promise<void> {
    const ipc = this.requireIPC("minimizeWindow");
    await ipc.invoke("desktop:minimizeWindow");
  }

  async maximizeWindow(): Promise<void> {
    const ipc = this.requireIPC("maximizeWindow");
    await ipc.invoke("desktop:maximizeWindow");
  }

  async unmaximizeWindow(): Promise<void> {
    const ipc = this.requireIPC("unmaximizeWindow");
    await ipc.invoke("desktop:unmaximizeWindow");
  }

  async closeWindow(): Promise<void> {
    const ipc = this.requireIPC("closeWindow");
    await ipc.invoke("desktop:closeWindow");
  }

  async showWindow(): Promise<void> {
    const ipc = this.requireIPC("showWindow");
    await ipc.invoke("desktop:showWindow");
  }

  async hideWindow(): Promise<void> {
    const ipc = this.requireIPC("hideWindow");
    await ipc.invoke("desktop:hideWindow");
  }

  async focusWindow(): Promise<void> {
    const ipc = this.requireIPC("focusWindow");
    await ipc.invoke("desktop:focusWindow");
  }

  async isWindowMaximized(): Promise<{ maximized: boolean }> {
    const ipc = this.requireIPC("isWindowMaximized");
    return (await ipc.invoke("desktop:isWindowMaximized")) as { maximized: boolean };
  }

  async isWindowMinimized(): Promise<{ minimized: boolean }> {
    const ipc = this.requireIPC("isWindowMinimized");
    return (await ipc.invoke("desktop:isWindowMinimized")) as { minimized: boolean };
  }

  async isWindowVisible(): Promise<{ visible: boolean }> {
    const ipc = this.requireIPC("isWindowVisible");
    return (await ipc.invoke("desktop:isWindowVisible")) as { visible: boolean };
  }

  async isWindowFocused(): Promise<{ focused: boolean }> {
    const ipc = this.requireIPC("isWindowFocused");
    return (await ipc.invoke("desktop:isWindowFocused")) as { focused: boolean };
  }

  async setAlwaysOnTop(options: { flag: boolean; level?: AlwaysOnTopLevel }): Promise<void> {
    const ipc = this.requireIPC("setAlwaysOnTop");
    await ipc.invoke("desktop:setAlwaysOnTop", options);
  }

  async setFullscreen(options: { flag: boolean }): Promise<void> {
    const ipc = this.requireIPC("setFullscreen");
    await ipc.invoke("desktop:setFullscreen", options);
  }

  async setOpacity(options: { opacity: number }): Promise<void> {
    const ipc = this.requireIPC("setOpacity");
    await ipc.invoke("desktop:setOpacity", options);
  }

  // Notifications
  async showNotification(options: NotificationOptions): Promise<{ id: string }> {
    const ipc = this.requireIPC("showNotification");
    return (await ipc.invoke("desktop:showNotification", options)) as { id: string };
  }

  async closeNotification(options: { id: string }): Promise<void> {
    const ipc = this.requireIPC("closeNotification");
    await ipc.invoke("desktop:closeNotification", options);
  }

  // Power Monitor
  async getPowerState(): Promise<PowerMonitorState> {
    const ipc = this.requireIPC("getPowerState");
    return (await ipc.invoke("desktop:getPowerState")) as PowerMonitorState;
  }

  // App
  async quit(): Promise<void> {
    const ipc = this.requireIPC("quit");
    await ipc.invoke("desktop:quit");
  }

  async relaunch(): Promise<void> {
    const ipc = this.requireIPC("relaunch");
    await ipc.invoke("desktop:relaunch");
  }

  async getVersion(): Promise<{ version: string; name: string; electron: string; chrome: string; node: string }> {
    const ipc = this.requireIPC("getVersion");
    return (await ipc.invoke("desktop:getVersion")) as { version: string; name: string; electron: string; chrome: string; node: string };
  }

  async isPackaged(): Promise<{ packaged: boolean }> {
    const ipc = this.requireIPC("isPackaged");
    return (await ipc.invoke("desktop:isPackaged")) as { packaged: boolean };
  }

  async getPath(options: { name: DesktopPathName }): Promise<{ path: string }> {
    const ipc = this.requireIPC("getPath");
    return (await ipc.invoke("desktop:getPath", options)) as { path: string };
  }

  // Clipboard
  async writeToClipboard(options: { text?: string; html?: string; image?: string; rtf?: string }): Promise<void> {
    const ipc = this.requireIPC("writeToClipboard");
    await ipc.invoke("desktop:writeToClipboard", options);
  }

  async readFromClipboard(): Promise<{ text?: string; html?: string; rtf?: string; hasImage: boolean }> {
    const ipc = this.requireIPC("readFromClipboard");
    return (await ipc.invoke("desktop:readFromClipboard")) as { text?: string; html?: string; rtf?: string; hasImage: boolean };
  }

  async clearClipboard(): Promise<void> {
    const ipc = this.requireIPC("clearClipboard");
    await ipc.invoke("desktop:clearClipboard");
  }

  // Shell
  async openExternal(options: { url: string }): Promise<void> {
    const ipc = this.requireIPC("openExternal");
    await ipc.invoke("desktop:openExternal", options);
  }

  async showItemInFolder(options: { path: string }): Promise<void> {
    const ipc = this.requireIPC("showItemInFolder");
    await ipc.invoke("desktop:showItemInFolder", options);
  }

  async beep(): Promise<void> {
    const ipc = this.requireIPC("beep");
    await ipc.invoke("desktop:beep");
  }

  // Events
  async addListener(
    eventName: "trayClick",
    listenerFunc: (event: TrayClickEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayDoubleClick",
    listenerFunc: (event: TrayClickEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayRightClick",
    listenerFunc: (event: TrayClickEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayMenuClick",
    listenerFunc: (event: TrayMenuClickEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "shortcutPressed",
    listenerFunc: (event: GlobalShortcutEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationClick",
    listenerFunc: (event: NotificationEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationAction",
    listenerFunc: (event: NotificationEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationReply",
    listenerFunc: (event: NotificationEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowFocus",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowBlur",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowMaximize",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowUnmaximize",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowMinimize",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowRestore",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowClose",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerSuspend",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerResume",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerOnAC",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerOnBattery",
    listenerFunc: () => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: DesktopEventName,
    listenerFunc: EventCallback<DesktopEventData>
  ): Promise<PluginListenerHandle> {
    const entry: ListenerEntry = { eventName, callback: listenerFunc };
    this.listeners.push(entry);

    return {
      remove: async () => {
        const idx = this.listeners.indexOf(entry);
        if (idx >= 0) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners = [];
  }

  private notifyListeners<T extends DesktopEventName>(
    eventName: T,
    data?: DesktopEventPayloads[T]
  ): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<DesktopEventPayloads[T]>)(data as DesktopEventPayloads[T]);
      }
    }
  }
}

// Export the plugin instance
export const Desktop = new DesktopElectron();

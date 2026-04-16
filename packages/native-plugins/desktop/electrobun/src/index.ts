/**
 * Desktop Plugin for Electrobun compatibility
 *
 * This module provides native desktop features for the desktop shell including:
 * - System tray management
 * - Global keyboard shortcuts
 * - Auto-launch on system startup
 * - Window management
 * - Native notifications
 * - Power monitoring
 * - Clipboard operations
 * - Shell operations
 *
 * This file should be loaded in the desktop main process and
 * its API exposed to the renderer via IPC.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "@elizaos/app-core";
import type { EventCallback, ListenerEntry as BaseListenerEntry } from "../../../shared-types.js";
import type {
  AutoLaunchOptions,
  DesktopPlugin,
  GlobalShortcut,
  GlobalShortcutEvent,
  NotificationEvent,
  NotificationOptions,
  PowerMonitorState,
  TrayClickEvent,
  TrayMenuClickEvent,
  TrayMenuItem,
  TrayOptions,
  WindowBounds,
  WindowOptions,
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
  windowFocus: undefined;
  windowBlur: undefined;
  windowMaximize: undefined;
  windowUnmaximize: undefined;
  windowMinimize: undefined;
  windowRestore: undefined;
  windowClose: undefined;
  powerSuspend: undefined;
  powerResume: undefined;
  powerOnAC: undefined;
  powerOnBattery: undefined;
};

type DesktopEventName = keyof DesktopEventPayloads;
type DesktopEventData = DesktopEventPayloads[DesktopEventName];

type ListenerEntry = BaseListenerEntry<DesktopEventName, DesktopEventData>;

type AlwaysOnTopLevel = Parameters<DesktopPlugin["setAlwaysOnTop"]>[0]["level"];
type DesktopPathName = Parameters<DesktopPlugin["getPath"]>[0]["name"];
type DesktopVersionResult =
  | {
      version: string;
      name: string;
      runtime: string;
    }
  | {
      version: string;
      name: string;
      runtime: string;
      chrome: string;
      node: string;
    };

const DESKTOP_RPC_EVENTS: Partial<
  Record<DesktopEventName, { rpcMessage: string; ipcChannel: string }>
> = {
  trayClick: {
    rpcMessage: "desktopTrayClick",
    ipcChannel: "desktop:trayClick",
  },
  trayMenuClick: {
    rpcMessage: "desktopTrayMenuClick",
    ipcChannel: "desktop:trayMenuClick",
  },
  shortcutPressed: {
    rpcMessage: "desktopShortcutPressed",
    ipcChannel: "desktop:shortcutPressed",
  },
  windowFocus: {
    rpcMessage: "desktopWindowFocus",
    ipcChannel: "desktop:windowFocus",
  },
  windowBlur: {
    rpcMessage: "desktopWindowBlur",
    ipcChannel: "desktop:windowBlur",
  },
  windowMaximize: {
    rpcMessage: "desktopWindowMaximize",
    ipcChannel: "desktop:windowMaximize",
  },
  windowUnmaximize: {
    rpcMessage: "desktopWindowUnmaximize",
    ipcChannel: "desktop:windowUnmaximize",
  },
  windowClose: {
    rpcMessage: "desktopWindowClose",
    ipcChannel: "desktop:windowClose",
  },
};

/**
 * Helper to throw when the desktop bridge is unavailable.
 * Desktop plugin features require the Electrobun native runtime.
 */
function requireIPC(feature: string): never {
  throw new Error(
    `${feature} is not available: desktop bridge not found. ` +
      "The Desktop plugin requires the Electrobun main process with properly configured handlers.",
  );
}

/**
 * Desktop Plugin implementation for Electrobun
 * Uses IPC to communicate with the main process
 */
export class DesktopElectrobun implements DesktopPlugin {
  private listeners: ListenerEntry[] = [];
  private internalSubscriptions: Array<() => void> = [];

  constructor() {
    this.setupDesktopListeners();
  }

  private async invokeBridge<T>(
    feature: string,
    rpcMethod: string,
    ipcChannel: string,
    params?: unknown,
  ): Promise<T> {
    const result = await invokeDesktopBridgeRequest<T>({
      rpcMethod,
      ipcChannel,
      params,
    });
    if (result === null) {
      requireIPC(feature);
    }
    return result as T;
  }

  private setupDesktopListeners(): void {
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
      const rpcEvent = DESKTOP_RPC_EVENTS[eventName];
      if (!rpcEvent) {
        continue;
      }

      const unsubscribe = subscribeDesktopBridgeEvent({
        rpcMessage: rpcEvent.rpcMessage,
        ipcChannel: rpcEvent.ipcChannel,
        listener: (data) => {
          this.notifyListeners(
            eventName,
            data as DesktopEventPayloads[typeof eventName],
          );
        },
      });
      this.internalSubscriptions.push(unsubscribe);
    }
  }

  // System Tray
  async createTray(options: TrayOptions): Promise<void> {
    await this.invokeBridge(
      "createTray",
      "desktopCreateTray",
      "desktop:createTray",
      options,
    );
  }

  async updateTray(options: Partial<TrayOptions>): Promise<void> {
    await this.invokeBridge(
      "updateTray",
      "desktopUpdateTray",
      "desktop:updateTray",
      options,
    );
  }

  async destroyTray(): Promise<void> {
    await this.invokeBridge(
      "destroyTray",
      "desktopDestroyTray",
      "desktop:destroyTray",
    );
  }

  async setTrayMenu(options: { menu: TrayMenuItem[] }): Promise<void> {
    await this.invokeBridge(
      "setTrayMenu",
      "desktopSetTrayMenu",
      "desktop:setTrayMenu",
      options,
    );
  }

  // Global Shortcuts
  async registerShortcut(
    options: GlobalShortcut,
  ): Promise<{ success: boolean }> {
    return await this.invokeBridge<{ success: boolean }>(
      "registerShortcut",
      "desktopRegisterShortcut",
      "desktop:registerShortcut",
      options,
    );
  }

  async unregisterShortcut(options: { id: string }): Promise<void> {
    await this.invokeBridge(
      "unregisterShortcut",
      "desktopUnregisterShortcut",
      "desktop:unregisterShortcut",
      options,
    );
  }

  async unregisterAllShortcuts(): Promise<void> {
    await this.invokeBridge(
      "unregisterAllShortcuts",
      "desktopUnregisterAllShortcuts",
      "desktop:unregisterAllShortcuts",
    );
  }

  async isShortcutRegistered(options: {
    accelerator: string;
  }): Promise<{ registered: boolean }> {
    return await this.invokeBridge<{ registered: boolean }>(
      "isShortcutRegistered",
      "desktopIsShortcutRegistered",
      "desktop:isShortcutRegistered",
      options,
    );
  }

  // Auto Launch
  async setAutoLaunch(options: AutoLaunchOptions): Promise<void> {
    await this.invokeBridge(
      "setAutoLaunch",
      "desktopSetAutoLaunch",
      "desktop:setAutoLaunch",
      options,
    );
  }

  async getAutoLaunchStatus(): Promise<{
    enabled: boolean;
    openAsHidden: boolean;
  }> {
    return await this.invokeBridge<{
      enabled: boolean;
      openAsHidden: boolean;
    }>(
      "getAutoLaunchStatus",
      "desktopGetAutoLaunchStatus",
      "desktop:getAutoLaunchStatus",
    );
  }

  // Window Management
  async setWindowOptions(options: WindowOptions): Promise<void> {
    await this.invokeBridge(
      "setWindowOptions",
      "desktopSetWindowOptions",
      "desktop:setWindowOptions",
      options,
    );
  }

  async getWindowBounds(): Promise<WindowBounds> {
    return await this.invokeBridge<WindowBounds>(
      "getWindowBounds",
      "desktopGetWindowBounds",
      "desktop:getWindowBounds",
    );
  }

  async setWindowBounds(options: WindowBounds): Promise<void> {
    await this.invokeBridge(
      "setWindowBounds",
      "desktopSetWindowBounds",
      "desktop:setWindowBounds",
      options,
    );
  }

  async minimizeWindow(): Promise<void> {
    await this.invokeBridge(
      "minimizeWindow",
      "desktopMinimizeWindow",
      "desktop:minimizeWindow",
    );
  }

  async maximizeWindow(): Promise<void> {
    await this.invokeBridge(
      "maximizeWindow",
      "desktopMaximizeWindow",
      "desktop:maximizeWindow",
    );
  }

  async unmaximizeWindow(): Promise<void> {
    await this.invokeBridge(
      "unmaximizeWindow",
      "desktopUnmaximizeWindow",
      "desktop:unmaximizeWindow",
    );
  }

  async closeWindow(): Promise<void> {
    await this.invokeBridge(
      "closeWindow",
      "desktopCloseWindow",
      "desktop:closeWindow",
    );
  }

  async showWindow(): Promise<void> {
    await this.invokeBridge(
      "showWindow",
      "desktopShowWindow",
      "desktop:showWindow",
    );
  }

  async hideWindow(): Promise<void> {
    await this.invokeBridge(
      "hideWindow",
      "desktopHideWindow",
      "desktop:hideWindow",
    );
  }

  async focusWindow(): Promise<void> {
    await this.invokeBridge(
      "focusWindow",
      "desktopFocusWindow",
      "desktop:focusWindow",
    );
  }

  async isWindowMaximized(): Promise<{ maximized: boolean }> {
    return await this.invokeBridge<{ maximized: boolean }>(
      "isWindowMaximized",
      "desktopIsWindowMaximized",
      "desktop:isWindowMaximized",
    );
  }

  async isWindowMinimized(): Promise<{ minimized: boolean }> {
    return await this.invokeBridge<{ minimized: boolean }>(
      "isWindowMinimized",
      "desktopIsWindowMinimized",
      "desktop:isWindowMinimized",
    );
  }

  async isWindowVisible(): Promise<{ visible: boolean }> {
    return await this.invokeBridge<{ visible: boolean }>(
      "isWindowVisible",
      "desktopIsWindowVisible",
      "desktop:isWindowVisible",
    );
  }

  async isWindowFocused(): Promise<{ focused: boolean }> {
    return await this.invokeBridge<{ focused: boolean }>(
      "isWindowFocused",
      "desktopIsWindowFocused",
      "desktop:isWindowFocused",
    );
  }

  async setAlwaysOnTop(options: {
    flag: boolean;
    level?: AlwaysOnTopLevel;
  }): Promise<void> {
    await this.invokeBridge(
      "setAlwaysOnTop",
      "desktopSetAlwaysOnTop",
      "desktop:setAlwaysOnTop",
      options,
    );
  }

  async setFullscreen(options: { flag: boolean }): Promise<void> {
    await this.invokeBridge(
      "setFullscreen",
      "desktopSetFullscreen",
      "desktop:setFullscreen",
      options,
    );
  }

  async setOpacity(options: { opacity: number }): Promise<void> {
    await this.invokeBridge(
      "setOpacity",
      "desktopSetOpacity",
      "desktop:setOpacity",
      options,
    );
  }

  // Notifications
  async showNotification(
    options: NotificationOptions,
  ): Promise<{ id: string }> {
    return await this.invokeBridge<{ id: string }>(
      "showNotification",
      "desktopShowNotification",
      "desktop:showNotification",
      options,
    );
  }

  async closeNotification(options: { id: string }): Promise<void> {
    await this.invokeBridge(
      "closeNotification",
      "desktopCloseNotification",
      "desktop:closeNotification",
      options,
    );
  }

  // Power Monitor
  async getPowerState(): Promise<PowerMonitorState> {
    return await this.invokeBridge<PowerMonitorState>(
      "getPowerState",
      "desktopGetPowerState",
      "desktop:getPowerState",
    );
  }

  // App
  async quit(): Promise<void> {
    await this.invokeBridge("quit", "desktopQuit", "desktop:quit");
  }

  async relaunch(): Promise<void> {
    await this.invokeBridge("relaunch", "desktopRelaunch", "desktop:relaunch");
  }

  async getVersion(): Promise<{
    version: string;
    name: string;
    runtime: string;
    chrome: string;
    node: string;
  }> {
    const version = await this.invokeBridge<DesktopVersionResult>(
      "getVersion",
      "desktopGetVersion",
      "desktop:getVersion",
    );
    if ("runtime" in version) {
      return {
        version: version.version,
        name: version.name,
        runtime: version.runtime,
        chrome: "N/A",
        node: "N/A",
      };
    }
    return version;
  }

  async isPackaged(): Promise<{ packaged: boolean }> {
    return await this.invokeBridge<{ packaged: boolean }>(
      "isPackaged",
      "desktopIsPackaged",
      "desktop:isPackaged",
    );
  }

  async getPath(options: { name: DesktopPathName }): Promise<{ path: string }> {
    return await this.invokeBridge<{ path: string }>(
      "getPath",
      "desktopGetPath",
      "desktop:getPath",
      options,
    );
  }

  // Clipboard
  async writeToClipboard(options: {
    text?: string;
    html?: string;
    image?: string;
    rtf?: string;
  }): Promise<void> {
    await this.invokeBridge(
      "writeToClipboard",
      "desktopWriteToClipboard",
      "desktop:writeToClipboard",
      options,
    );
  }

  async readFromClipboard(): Promise<{
    text?: string;
    html?: string;
    rtf?: string;
    hasImage: boolean;
  }> {
    return await this.invokeBridge<{
      text?: string;
      html?: string;
      rtf?: string;
      hasImage: boolean;
    }>(
      "readFromClipboard",
      "desktopReadFromClipboard",
      "desktop:readFromClipboard",
    );
  }

  async clearClipboard(): Promise<void> {
    await this.invokeBridge(
      "clearClipboard",
      "desktopClearClipboard",
      "desktop:clearClipboard",
    );
  }

  // Shell
  async openExternal(options: { url: string }): Promise<void> {
    await this.invokeBridge(
      "openExternal",
      "desktopOpenExternal",
      "desktop:openExternal",
      options,
    );
  }

  async showItemInFolder(options: { path: string }): Promise<void> {
    await this.invokeBridge(
      "showItemInFolder",
      "desktopShowItemInFolder",
      "desktop:showItemInFolder",
      options,
    );
  }

  async beep(): Promise<void> {
    await this.invokeBridge("beep", "desktopBeep", "desktop:beep");
  }

  // Events
  async addListener(
    eventName: "trayClick",
    listenerFunc: (event: TrayClickEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayDoubleClick",
    listenerFunc: (event: TrayClickEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayRightClick",
    listenerFunc: (event: TrayClickEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "trayMenuClick",
    listenerFunc: (event: TrayMenuClickEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "shortcutPressed",
    listenerFunc: (event: GlobalShortcutEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationClick",
    listenerFunc: (event: NotificationEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationAction",
    listenerFunc: (event: NotificationEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "notificationReply",
    listenerFunc: (event: NotificationEvent) => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowFocus",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowBlur",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowMaximize",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowUnmaximize",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowMinimize",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowRestore",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "windowClose",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerSuspend",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerResume",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerOnAC",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "powerOnBattery",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: DesktopEventName,
    listenerFunc: EventCallback<DesktopEventData>,
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
    data?: DesktopEventPayloads[T],
  ): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<DesktopEventPayloads[T]>)(
          data as DesktopEventPayloads[T],
        );
      }
    }
  }
}

// Export the plugin instance
export const Desktop = new DesktopElectrobun();

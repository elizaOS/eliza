import { WebPlugin } from "@capacitor/core";

import type {
  DesktopPlugin,
  TrayOptions,
  TrayMenuItem,
  GlobalShortcut,
  AutoLaunchOptions,
  WindowOptions,
  WindowBounds,
  NotificationOptions,
  PowerMonitorState,
  TrayClickEvent,
  TrayMenuClickEvent,
  GlobalShortcutEvent,
  NotificationEvent,
} from "./definitions";

type DesktopEventData = TrayClickEvent | TrayMenuClickEvent | GlobalShortcutEvent | NotificationEvent | void;

const webUnavailable = (feature: string) => console.warn(`${feature} is not available in browser environment`);

export class DesktopWeb extends WebPlugin {
  private pluginListeners: Array<{ eventName: string; callback: (event: DesktopEventData) => void; windowListener?: () => void }> = [];

  // System Tray - Not available in browser
  async createTray(_options: TrayOptions): Promise<void> { webUnavailable("System tray"); }
  async updateTray(_options: Partial<TrayOptions>): Promise<void> { webUnavailable("System tray"); }
  async destroyTray(): Promise<void> { webUnavailable("System tray"); }
  async setTrayMenu(_options: { menu: TrayMenuItem[] }): Promise<void> { webUnavailable("System tray"); }

  // Global Shortcuts - Not available in browser
  async registerShortcut(_options: GlobalShortcut): Promise<{ success: boolean }> { webUnavailable("Global shortcuts"); return { success: false }; }
  async unregisterShortcut(_options: { id: string }): Promise<void> { webUnavailable("Global shortcuts"); }
  async unregisterAllShortcuts(): Promise<void> { webUnavailable("Global shortcuts"); }
  async isShortcutRegistered(_options: { accelerator: string }): Promise<{ registered: boolean }> { return { registered: false }; }

  // Auto Launch - Not available in browser
  async setAutoLaunch(_options: AutoLaunchOptions): Promise<void> { webUnavailable("Auto launch"); }
  async getAutoLaunchStatus(): Promise<{ enabled: boolean; openAsHidden: boolean }> { return { enabled: false, openAsHidden: false }; }

  // Window Management - Limited in browser
  async setWindowOptions(_options: WindowOptions): Promise<void> { webUnavailable("Window options"); }
  async getWindowBounds(): Promise<WindowBounds> { return { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }; }
  async setWindowBounds(_options: WindowBounds): Promise<void> { webUnavailable("Setting window bounds"); }
  async minimizeWindow(): Promise<void> { webUnavailable("Window minimize"); }
  async maximizeWindow(): Promise<void> { webUnavailable("Window maximize"); }
  async unmaximizeWindow(): Promise<void> { webUnavailable("Window unmaximize"); }
  async closeWindow(): Promise<void> { window.close(); }
  async showWindow(): Promise<void> { window.focus(); }
  async hideWindow(): Promise<void> { webUnavailable("Window hide"); }
  async focusWindow(): Promise<void> { window.focus(); }
  async isWindowMaximized(): Promise<{ maximized: boolean }> { return { maximized: false }; }
  async isWindowMinimized(): Promise<{ minimized: boolean }> { return { minimized: document.hidden }; }
  async isWindowVisible(): Promise<{ visible: boolean }> { return { visible: !document.hidden }; }
  async isWindowFocused(): Promise<{ focused: boolean }> { return { focused: document.hasFocus() }; }
  async setAlwaysOnTop(_options: { flag: boolean }): Promise<void> { webUnavailable("Always on top"); }
  async setFullscreen(options: { flag: boolean }): Promise<void> { options.flag ? document.documentElement.requestFullscreen() : document.exitFullscreen(); }
  async setOpacity(_options: { opacity: number }): Promise<void> { webUnavailable("Window opacity"); }

  // Notifications - Using Web Notification API
  async showNotification(options: NotificationOptions): Promise<{ id: string; shown: boolean; error?: string }> {
    const id = `notification_${Date.now()}`;

    if (!("Notification" in window)) {
      return { id, shown: false, error: "Notification API not available in this browser" };
    }

    if (Notification.permission === "denied") {
      return { id, shown: false, error: "Notification permission denied" };
    }

    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return { id, shown: false, error: "Notification permission not granted" };
      }
    }

    const notification = new Notification(options.title, { body: options.body, icon: options.icon, silent: options.silent });
    notification.onclick = () => this.notifyListeners("notificationClick", {});
    return { id, shown: true };
  }

  async closeNotification(_options: { id: string }): Promise<void> {
    // Web Notification API doesn't provide a way to close notifications by ID.
    // Notifications auto-close or the user dismisses them.
  }

  // Power Monitor
  async getPowerState(): Promise<PowerMonitorState> {
    type BatteryManager = { level: number; charging: boolean };
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }).getBattery;

    if (getBattery) {
      try {
        const battery = await getBattery.call(navigator);
        return {
          onBattery: !battery.charging,
          batteryLevel: battery.level * 100,
          isCharging: battery.charging,
          idleState: "active", // Idle detection not available on web
          idleTime: 0,
        };
    } catch (err) {
      console.debug("[Desktop] Battery API access failed:", err);
    }
    }

    return {
      onBattery: false, // Unknown, defaulting to false
      idleState: "unknown",
      idleTime: 0,
    };
  }

  // App
  async quit(): Promise<void> { window.close(); }
  async relaunch(): Promise<void> { window.location.reload(); }
  async getVersion(): Promise<{ version: string; name: string; electron: string; chrome: string; node: string }> {
    // On web platform, version info is limited. Return actual browser info where available.
    // Note: "version" and "name" would need to come from app config - returning "unknown" to indicate unavailability
    return {
      version: "unknown", // App version not available on web - would need to be injected at build time
      name: "unknown",    // App name not available on web - would need to be injected at build time
      electron: "N/A",    // Not running in Electron
      chrome: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] ?? "unknown",
      node: "N/A",        // Not running in Node
    };
  }
  async isPackaged(): Promise<{ packaged: boolean }> { return { packaged: false }; }
  async getPath(_options: { name: string }): Promise<{ path: string }> {
    throw new Error("File system paths are not available in browser environment");
  }

  // Clipboard
  async writeToClipboard(options: { text?: string; html?: string }): Promise<void> {
    if (options.text) { await navigator.clipboard.writeText(options.text); return; }
    if (options.html) { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([options.html], { type: "text/html" }) })]); }
  }
  async readFromClipboard(): Promise<{ text?: string; html?: string; rtf?: string; hasImage: boolean }> {
    return { text: await navigator.clipboard.readText(), hasImage: false };
  }
  async clearClipboard(): Promise<void> { await navigator.clipboard.writeText(""); }

  // Shell
  async openExternal(options: { url: string }): Promise<void> { window.open(options.url, "_blank"); }
  async showItemInFolder(_options: { path: string }): Promise<void> { webUnavailable("Show in folder"); }

  async beep(): Promise<void> {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  }

  // Events
  async addListener(eventName: string, listenerFunc: (event: DesktopEventData) => void): Promise<{ remove: () => Promise<void> }> {
    const entry: { eventName: string; callback: (event: DesktopEventData) => void; windowListener?: () => void } = { eventName, callback: listenerFunc };

    // Create and track window event listeners to avoid memory leaks
    if (eventName === "windowFocus") {
      entry.windowListener = () => listenerFunc();
      window.addEventListener("focus", entry.windowListener);
    } else if (eventName === "windowBlur") {
      entry.windowListener = () => listenerFunc();
      window.addEventListener("blur", entry.windowListener);
    }

    this.pluginListeners.push(entry);

    return {
      remove: async () => {
        const i = this.pluginListeners.indexOf(entry);
        if (i >= 0) {
          // Remove window event listener if it exists
          if (entry.windowListener) {
            if (entry.eventName === "windowFocus") window.removeEventListener("focus", entry.windowListener);
            else if (entry.eventName === "windowBlur") window.removeEventListener("blur", entry.windowListener);
          }
          this.pluginListeners.splice(i, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    // Clean up all window event listeners before clearing
    for (const entry of this.pluginListeners) {
      if (entry.windowListener) {
        if (entry.eventName === "windowFocus") window.removeEventListener("focus", entry.windowListener);
        else if (entry.eventName === "windowBlur") window.removeEventListener("blur", entry.windowListener);
      }
    }
    this.pluginListeners = [];
  }

  protected notifyListeners(eventName: string, data: DesktopEventData): void {
    this.pluginListeners.filter((l) => l.eventName === eventName).forEach((l) => l.callback(data));
  }
}

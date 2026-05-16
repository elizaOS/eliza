import { WebPlugin } from "@capacitor/core";

import type {
  AutoLaunchOptions,
  DesktopPermissionId,
  DesktopPermissionState,
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
} from "./definitions";

type DesktopEventData =
  | TrayClickEvent
  | TrayMenuClickEvent
  | GlobalShortcutEvent
  | NotificationEvent
  | undefined;

type ElectrobunRequestHandler = (params?: unknown) => Promise<unknown>;
type ElectrobunRendererRpc = {
  request?: Record<string, ElectrobunRequestHandler>;
};

interface DesktopBridgeWindow extends Window {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
}

const BROWSER_PERMISSION_IDS = new Set<DesktopPermissionId>([
  "camera",
  "microphone",
  "location",
  "notifications",
]);

function getDesktopRpc(): ElectrobunRendererRpc | undefined {
  const g = globalThis as typeof globalThis & {
    window?: DesktopBridgeWindow;
    __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
  };
  if (typeof window !== "undefined") {
    return (window as DesktopBridgeWindow).__ELIZA_ELECTROBUN_RPC__;
  }
  return g.window?.__ELIZA_ELECTROBUN_RPC__ ?? g.__ELIZA_ELECTROBUN_RPC__;
}

function currentPlatform(): DesktopPermissionState["platform"] {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  const p = proc?.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "darwin";
    if (platform.includes("win")) return "win32";
  }
  return "linux";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isDesktopPermissionState(
  value: unknown,
  id: DesktopPermissionId,
): value is DesktopPermissionState {
  return (
    isRecord(value) &&
    value.id === id &&
    typeof value.status === "string" &&
    typeof value.canRequest === "boolean" &&
    typeof value.lastChecked === "number"
  );
}

function stateFromStatus(
  id: DesktopPermissionId,
  status: DesktopPermissionState["status"],
  options: Partial<Omit<DesktopPermissionState, "id" | "status">> = {},
): DesktopPermissionState {
  const state: DesktopPermissionState = {
    id,
    status,
    lastChecked: options.lastChecked ?? Date.now(),
    canRequest: options.canRequest ?? status === "not-determined",
    platform: options.platform ?? currentPlatform(),
  };
  if (options.lastRequested !== undefined) {
    state.lastRequested = options.lastRequested;
  }
  if (options.restrictedReason !== undefined) {
    state.restrictedReason = options.restrictedReason;
  }
  return state;
}

function mapBrowserPermissionState(
  state: PermissionStatus["state"] | NotificationPermission | undefined,
): DesktopPermissionState["status"] | null {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  if (state === "prompt" || state === "default") return "not-determined";
  return null;
}

async function queryBrowserPermission(
  id: DesktopPermissionId,
): Promise<DesktopPermissionState | null> {
  if (!BROWSER_PERMISSION_IDS.has(id) || typeof navigator === "undefined") {
    return null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapBrowserPermissionState(Notification.permission);
    return status ? stateFromStatus(id, status) : null;
  }

  if (!navigator.permissions?.query) {
    return null;
  }

  const permissionName =
    id === "location" ? "geolocation" : (id as PermissionName);
  try {
    const result = await navigator.permissions.query({
      name: permissionName as PermissionName,
    });
    const status = mapBrowserPermissionState(result.state);
    return status ? stateFromStatus(id, status) : null;
  } catch {
    return null;
  }
}

async function requestBrowserPermission(
  id: DesktopPermissionId,
): Promise<DesktopPermissionState | null> {
  if (!BROWSER_PERMISSION_IDS.has(id) || typeof navigator === "undefined") {
    return null;
  }

  if (id === "camera" || id === "microphone") {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        video: id === "camera",
        audio: id === "microphone",
      });
      for (const track of stream?.getTracks?.() ?? []) {
        track.stop();
      }
    } catch {
      // Query below returns denied when the browser recorded a denial.
    }
    const checked = await queryBrowserPermission(id);
    return checked ? { ...checked, lastRequested: Date.now() } : null;
  }

  if (id === "location" && navigator.geolocation) {
    const requestedStatus = await new Promise<
      DesktopPermissionState["status"] | null
    >((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve("granted"),
        (err) => resolve(err.code === err.PERMISSION_DENIED ? "denied" : null),
        { maximumAge: 0, timeout: 10_000 },
      );
    });
    const checked = await queryBrowserPermission(id);
    if (checked) return { ...checked, lastRequested: Date.now() };
    return requestedStatus
      ? stateFromStatus(id, requestedStatus, { lastRequested: Date.now() })
      : null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapBrowserPermissionState(
      await Notification.requestPermission(),
    );
    return status
      ? stateFromStatus(id, status, { lastRequested: Date.now() })
      : null;
  }

  return queryBrowserPermission(id);
}

export class DesktopWeb extends WebPlugin {
  private pluginListeners: Array<{
    eventName: string;
    callback: (event: DesktopEventData) => void;
    windowListener?: () => void;
  }> = [];

  // System Tray - Not available in browser
  async createTray(_options: TrayOptions): Promise<void> {}
  async updateTray(_options: Partial<TrayOptions>): Promise<void> {}
  async destroyTray(): Promise<void> {}
  async setTrayMenu(_options: { menu: TrayMenuItem[] }): Promise<void> {}

  // Global Shortcuts - Not available in browser
  async registerShortcut(
    _options: GlobalShortcut,
  ): Promise<{ success: boolean }> {
    return { success: false };
  }
  async unregisterShortcut(_options: { id: string }): Promise<void> {}
  async unregisterAllShortcuts(): Promise<void> {}
  async isShortcutRegistered(_options: {
    accelerator: string;
  }): Promise<{ registered: boolean }> {
    return { registered: false };
  }

  // Auto Launch - Not available in browser
  async setAutoLaunch(_options: AutoLaunchOptions): Promise<void> {}
  async getAutoLaunchStatus(): Promise<{
    enabled: boolean;
    openAsHidden: boolean;
  }> {
    return { enabled: false, openAsHidden: false };
  }

  // Window Management - Limited in browser
  async setWindowOptions(_options: WindowOptions): Promise<void> {}
  async getWindowBounds(): Promise<WindowBounds> {
    return {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
  }
  async setWindowBounds(_options: WindowBounds): Promise<void> {}
  async minimizeWindow(): Promise<void> {}
  async maximizeWindow(): Promise<void> {}
  async unmaximizeWindow(): Promise<void> {}
  async closeWindow(): Promise<void> {
    window.close();
  }
  async showWindow(): Promise<void> {
    window.focus();
  }
  async hideWindow(): Promise<void> {}
  async focusWindow(): Promise<void> {
    window.focus();
  }
  async isWindowMaximized(): Promise<{ maximized: boolean }> {
    return { maximized: false };
  }
  async isWindowMinimized(): Promise<{ minimized: boolean }> {
    return { minimized: document.hidden };
  }
  async isWindowVisible(): Promise<{ visible: boolean }> {
    return { visible: !document.hidden };
  }
  async isWindowFocused(): Promise<{ focused: boolean }> {
    return { focused: document.hasFocus() };
  }
  async setAlwaysOnTop(_options: { flag: boolean }): Promise<void> {}
  async setFullscreen(options: { flag: boolean }): Promise<void> {
    options.flag
      ? document.documentElement.requestFullscreen()
      : document.exitFullscreen();
  }
  async setOpacity(_options: { opacity: number }): Promise<void> {}

  // Notifications - Using Web Notification API
  async showNotification(
    options: NotificationOptions,
  ): Promise<{ id: string; shown: boolean; error?: string }> {
    const id = `notification_${Date.now()}`;

    if (!("Notification" in window)) {
      return {
        id,
        shown: false,
        error: "Notification API not available in this browser",
      };
    }

    if (Notification.permission === "denied") {
      return { id, shown: false, error: "Notification permission denied" };
    }

    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return {
          id,
          shown: false,
          error: "Notification permission not granted",
        };
      }
    }

    const notification = new Notification(options.title, {
      body: options.body,
      icon: options.icon,
      silent: options.silent,
    });
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
    const getBattery = (
      navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
    ).getBattery;

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
  async quit(): Promise<void> {
    window.close();
  }
  async relaunch(): Promise<void> {
    window.location.reload();
  }
  async getVersion(): Promise<{
    version: string;
    name: string;
    runtime: string;
    chrome: string;
    node: string;
  }> {
    // On web platform, version info is limited. Return actual browser info where available.
    // Note: "version" and "name" would need to come from app config - returning "unknown" to indicate unavailability
    return {
      version: "unknown", // App version not available on web - would need to be injected at build time
      name: "unknown", // App name not available on web - would need to be injected at build time
      runtime: "N/A", // Not running in the desktop runtime
      chrome: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] ?? "unknown",
      node: "N/A", // Not running in Node
    };
  }
  async isPackaged(): Promise<{ packaged: boolean }> {
    return { packaged: false };
  }
  async getPath(_options: { name: string }): Promise<{ path: string }> {
    throw new Error(
      "File system paths are not available in browser environment",
    );
  }

  // Clipboard
  async writeToClipboard(options: {
    text?: string;
    html?: string;
  }): Promise<void> {
    if (options.text) {
      await navigator.clipboard.writeText(options.text);
      return;
    }
    if (options.html) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([options.html], { type: "text/html" }),
        }),
      ]);
    }
  }
  async readFromClipboard(): Promise<{
    text?: string;
    html?: string;
    rtf?: string;
    hasImage: boolean;
  }> {
    return { text: await navigator.clipboard.readText(), hasImage: false };
  }
  async clearClipboard(): Promise<void> {
    await navigator.clipboard.writeText("");
  }

  // Shell
  async openExternal(options: { url: string }): Promise<void> {
    window.open(options.url, "_blank");
  }
  async showItemInFolder(_options: { path: string }): Promise<void> {}

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
  async addListener(
    eventName: string,
    listenerFunc: (event: DesktopEventData) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const entry: {
      eventName: string;
      callback: (event: DesktopEventData) => void;
      windowListener?: () => void;
    } = { eventName, callback: listenerFunc };

    // Create and track window event listeners to avoid memory leaks
    if (eventName === "windowFocus") {
      entry.windowListener = () => listenerFunc(undefined);
      window.addEventListener("focus", entry.windowListener);
    } else if (eventName === "windowBlur") {
      entry.windowListener = () => listenerFunc(undefined);
      window.addEventListener("blur", entry.windowListener);
    }

    this.pluginListeners.push(entry);

    return {
      remove: async () => {
        const i = this.pluginListeners.indexOf(entry);
        if (i >= 0) {
          // Remove window event listener if it exists
          if (entry.windowListener) {
            if (entry.eventName === "windowFocus")
              window.removeEventListener("focus", entry.windowListener);
            else if (entry.eventName === "windowBlur")
              window.removeEventListener("blur", entry.windowListener);
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
        if (entry.eventName === "windowFocus")
          window.removeEventListener("focus", entry.windowListener);
        else if (entry.eventName === "windowBlur")
          window.removeEventListener("blur", entry.windowListener);
      }
    }
    this.pluginListeners = [];
  }

  protected notifyListeners(eventName: string, data: DesktopEventData): void {
    this.pluginListeners
      .filter((l) => l.eventName === eventName)
      .forEach((l) => {
        l.callback(data);
      });
  }

  async checkPermission(options: {
    id: DesktopPermissionId;
  }): Promise<DesktopPermissionState> {
    const rpc = getDesktopRpc();
    const request = rpc?.request?.permissionsCheck;
    if (request) {
      const bridged = await request.call(rpc.request, { id: options.id });
      if (isDesktopPermissionState(bridged, options.id)) return bridged;
    }

    const browserState = await queryBrowserPermission(options.id);
    if (browserState) return browserState;

    return {
      id: options.id,
      status: "not-applicable",
      restrictedReason: "platform_unsupported",
      lastChecked: Date.now(),
      canRequest: false,
      platform: currentPlatform(),
    };
  }

  async requestPermission(options: {
    id: DesktopPermissionId;
    reason: string;
  }): Promise<DesktopPermissionState> {
    const rpc = getDesktopRpc();
    const request = rpc?.request?.permissionsRequest;
    if (request) {
      const bridged = await request.call(rpc.request, { id: options.id });
      if (isDesktopPermissionState(bridged, options.id)) {
        if (
          bridged.status === "not-determined" &&
          BROWSER_PERMISSION_IDS.has(options.id)
        ) {
          return (await requestBrowserPermission(options.id)) ?? bridged;
        }
        return bridged;
      }
    }

    return (
      (await requestBrowserPermission(options.id)) ??
      this.checkPermission({ id: options.id })
    );
  }
}

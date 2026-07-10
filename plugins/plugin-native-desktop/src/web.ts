/**
 * Web-side implementation of the Desktop Capacitor plugin. Capacitor always
 * resolves this class in the renderer (there is no Capacitor-native desktop
 * container), so every method is bridge-first: when the Electrobun host has
 * injected `__ELIZA_ELECTROBUN_RPC__`, calls proxy to the host's `desktop*`
 * RPC handlers (tray, shortcuts, window management, quit, version, …) and
 * events subscribe to the host's `desktop*` bridge messages. Without the
 * bridge (a plain browser tab) each method degrades to a Web API equivalent
 * (Notifications, Clipboard, Fullscreen, Battery, `navigator.permissions`)
 * or an explicit unavailable/no-op result — never a throw.
 */
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
type ElectrobunMessageListener = (payload: unknown) => void;
type ElectrobunRendererRpc = {
  request?: Record<string, ElectrobunRequestHandler>;
  onMessage?: (
    messageName: string,
    listener: ElectrobunMessageListener,
  ) => void;
  offMessage?: (
    messageName: string,
    listener: ElectrobunMessageListener,
  ) => void;
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
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function assertSafeExternalUrl(url: unknown): string {
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new Error("url must be a non-empty external URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 untrusted url failed to parse; throw an explicit validation error
    throw new Error("url must be a valid external URL");
  }
  if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("url protocol is not allowed");
  }
  return parsed.toString();
}

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

/**
 * Sentinel distinguishing "the Electrobun bridge is absent (or lacks this
 * method)" from a legitimate `undefined` RPC response, so void RPC methods
 * don't get double-handled by the browser fallback.
 */
const BRIDGE_ABSENT: unique symbol = Symbol("desktop-bridge-absent");

/**
 * Invoke the Electrobun host's Desktop RPC method for a plugin method name.
 * The host registers every handler as `desktop` + PascalCase(method) (see the
 * Electrobun shell's rpc-schema), so `setTrayMenu` → `desktopSetTrayMenu`.
 * Returns BRIDGE_ABSENT when no bridge (plain browser tab) or the host build
 * doesn't expose the method — callers then run their Web API fallback.
 */
async function bridgeRequest(
  method: string,
  params?: unknown,
): Promise<unknown> {
  const rpc = getDesktopRpc();
  const rpcMethod = `desktop${method[0].toUpperCase()}${method.slice(1)}`;
  const request = rpc?.request?.[rpcMethod];
  if (!request || !rpc?.request) return BRIDGE_ABSENT;
  return await request.call(rpc.request, params);
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
    // error-policy:J4 Permissions API cannot query this permission here; return null (unknown state)
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
      // error-policy:J4 getUserMedia rejection is expected on denial; the real state is re-read below
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
    bridgeListener?: (payload: unknown) => void;
    bridgeMessageName?: string;
  }> = [];

  // System Tray — Electrobun host via RPC; not available in a browser tab
  async createTray(options: TrayOptions): Promise<void> {
    await bridgeRequest("createTray", options);
  }
  async updateTray(options: Partial<TrayOptions>): Promise<void> {
    await bridgeRequest("updateTray", options);
  }
  async destroyTray(): Promise<void> {
    await bridgeRequest("destroyTray");
  }
  async setTrayMenu(options: { menu: TrayMenuItem[] }): Promise<void> {
    await bridgeRequest("setTrayMenu", options);
  }

  // Global Shortcuts — Electrobun host via RPC; not available in a browser tab
  async registerShortcut(
    options: GlobalShortcut,
  ): Promise<{ success: boolean }> {
    const bridged = await bridgeRequest("registerShortcut", options);
    if (bridged !== BRIDGE_ABSENT) {
      return isRecord(bridged) && typeof bridged.success === "boolean"
        ? { success: bridged.success }
        : { success: true };
    }
    return { success: false };
  }
  async unregisterShortcut(options: { id: string }): Promise<void> {
    await bridgeRequest("unregisterShortcut", options);
  }
  async unregisterAllShortcuts(): Promise<void> {
    await bridgeRequest("unregisterAllShortcuts");
  }
  async isShortcutRegistered(options: {
    accelerator: string;
  }): Promise<{ registered: boolean }> {
    const bridged = await bridgeRequest("isShortcutRegistered", options);
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.registered === "boolean"
    ) {
      return { registered: bridged.registered };
    }
    return { registered: false };
  }

  // Auto Launch — Electrobun host via RPC; not available in a browser tab
  async setAutoLaunch(options: AutoLaunchOptions): Promise<void> {
    await bridgeRequest("setAutoLaunch", options);
  }
  async getAutoLaunchStatus(): Promise<{
    enabled: boolean;
    openAsHidden: boolean;
  }> {
    const bridged = await bridgeRequest("getAutoLaunchStatus");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.enabled === "boolean"
    ) {
      return {
        enabled: bridged.enabled,
        openAsHidden:
          typeof bridged.openAsHidden === "boolean"
            ? bridged.openAsHidden
            : false,
      };
    }
    return { enabled: false, openAsHidden: false };
  }

  // Window Management — Electrobun host via RPC; limited in a browser tab
  async setWindowOptions(options: WindowOptions): Promise<void> {
    await bridgeRequest("setWindowOptions", options);
  }
  async getWindowBounds(): Promise<WindowBounds> {
    const bridged = await bridgeRequest("getWindowBounds");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.x === "number"
    ) {
      return bridged as unknown as WindowBounds;
    }
    return {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
  }
  async setWindowBounds(options: WindowBounds): Promise<void> {
    await bridgeRequest("setWindowBounds", options);
  }
  async minimizeWindow(): Promise<void> {
    await bridgeRequest("minimizeWindow");
  }
  async maximizeWindow(): Promise<void> {
    await bridgeRequest("maximizeWindow");
  }
  async unmaximizeWindow(): Promise<void> {
    await bridgeRequest("unmaximizeWindow");
  }
  async closeWindow(): Promise<void> {
    if ((await bridgeRequest("closeWindow")) !== BRIDGE_ABSENT) return;
    window.close();
  }
  async showWindow(): Promise<void> {
    if ((await bridgeRequest("showWindow")) !== BRIDGE_ABSENT) return;
    window.focus();
  }
  async hideWindow(): Promise<void> {
    await bridgeRequest("hideWindow");
  }
  async focusWindow(): Promise<void> {
    if ((await bridgeRequest("focusWindow")) !== BRIDGE_ABSENT) return;
    window.focus();
  }
  async isWindowMaximized(): Promise<{ maximized: boolean }> {
    const bridged = await bridgeRequest("isWindowMaximized");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.maximized === "boolean"
    ) {
      return { maximized: bridged.maximized };
    }
    return { maximized: false };
  }
  async isWindowMinimized(): Promise<{ minimized: boolean }> {
    const bridged = await bridgeRequest("isWindowMinimized");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.minimized === "boolean"
    ) {
      return { minimized: bridged.minimized };
    }
    return { minimized: document.hidden };
  }
  async isWindowVisible(): Promise<{ visible: boolean }> {
    const bridged = await bridgeRequest("isWindowVisible");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.visible === "boolean"
    ) {
      return { visible: bridged.visible };
    }
    return { visible: !document.hidden };
  }
  async isWindowFocused(): Promise<{ focused: boolean }> {
    const bridged = await bridgeRequest("isWindowFocused");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.focused === "boolean"
    ) {
      return { focused: bridged.focused };
    }
    return { focused: document.hasFocus() };
  }
  async setAlwaysOnTop(options: { flag: boolean }): Promise<void> {
    await bridgeRequest("setAlwaysOnTop", options);
  }
  async setFullscreen(options: { flag: boolean }): Promise<void> {
    if ((await bridgeRequest("setFullscreen", options)) !== BRIDGE_ABSENT) {
      return;
    }
    options.flag
      ? document.documentElement.requestFullscreen()
      : document.exitFullscreen();
  }
  async setOpacity(options: { opacity: number }): Promise<void> {
    await bridgeRequest("setOpacity", options);
  }

  // Notifications - Using Web Notification API
  async showNotification(
    options: NotificationOptions,
  ): Promise<{ id: string; shown: boolean; error?: string }> {
    const bridged = await bridgeRequest("showNotification", options);
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.id === "string" &&
      typeof bridged.shown === "boolean"
    ) {
      return bridged as { id: string; shown: boolean; error?: string };
    }

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

  async closeNotification(options: { id: string }): Promise<void> {
    // Web Notification API doesn't provide a way to close notifications by ID.
    // Notifications auto-close or the user dismisses them.
    await bridgeRequest("closeNotification", options);
  }

  // Power Monitor
  async getPowerState(): Promise<PowerMonitorState> {
    const bridged = await bridgeRequest("getPowerState");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.onBattery === "boolean"
    ) {
      return bridged as unknown as PowerMonitorState;
    }

    type BatteryManager = { level?: unknown; charging?: unknown };
    const getBattery = (
      navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
    ).getBattery;

    if (getBattery) {
      try {
        const battery = await getBattery.call(navigator);
        const level =
          typeof battery.level === "number" && Number.isFinite(battery.level)
            ? Math.max(0, Math.min(100, battery.level * 100))
            : undefined;
        const charging =
          typeof battery.charging === "boolean" ? battery.charging : undefined;
        return {
          onBattery: charging === undefined ? false : !charging,
          batteryLevel: level,
          isCharging: charging,
          idleState: "active", // Idle detection not available on web
          idleTime: 0,
        };
      } catch (err) {
        // error-policy:J4 the Battery API is an optional web capability; when a
        // present getBattery() rejects we degrade to the honest "unknown" power
        // state below rather than fail the call. No elizaOS logger is reachable
        // in this dependency-free Capacitor web plugin; console is the webview
        // surface.
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
    if ((await bridgeRequest("quit")) !== BRIDGE_ABSENT) return;
    window.close();
  }
  async relaunch(): Promise<void> {
    if ((await bridgeRequest("relaunch")) !== BRIDGE_ABSENT) return;
    window.location.reload();
  }
  async getVersion(): Promise<{
    version: string;
    name: string;
    runtime: string;
    chrome: string;
    node: string;
  }> {
    // The `runtime` field is load-bearing: the app shell only wires desktop
    // features (tray menu, global shortcuts, quit) when it is a real value —
    // "N/A"/"unknown" means "plain browser tab, skip desktop wiring".
    const bridged = await bridgeRequest("getVersion");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.version === "string"
    ) {
      const chrome =
        typeof bridged.chrome === "string" ? bridged.chrome : "unknown";
      return {
        version: bridged.version,
        name: typeof bridged.name === "string" ? bridged.name : "unknown",
        runtime:
          typeof bridged.runtime === "string" && bridged.runtime.length > 0
            ? bridged.runtime
            : "electrobun",
        chrome,
        node: typeof bridged.node === "string" ? bridged.node : "N/A",
      };
    }
    return {
      version: "unknown", // App version not available on web - would need to be injected at build time
      name: "unknown", // App name not available on web - would need to be injected at build time
      runtime: "N/A", // Not running in the desktop runtime
      chrome: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] ?? "unknown",
      node: "N/A", // Not running in Node
    };
  }
  async isPackaged(): Promise<{ packaged: boolean }> {
    const bridged = await bridgeRequest("isPackaged");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.packaged === "boolean"
    ) {
      return { packaged: bridged.packaged };
    }
    return { packaged: false };
  }
  async getPath(options: { name: string }): Promise<{ path: string }> {
    const bridged = await bridgeRequest("getPath", options);
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.path === "string"
    ) {
      return { path: bridged.path };
    }
    throw new Error(
      "File system paths are not available in browser environment",
    );
  }

  // Clipboard
  async writeToClipboard(options: {
    text?: string;
    html?: string;
  }): Promise<void> {
    if ((await bridgeRequest("writeToClipboard", options)) !== BRIDGE_ABSENT) {
      return;
    }
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
    const bridged = await bridgeRequest("readFromClipboard");
    if (
      bridged !== BRIDGE_ABSENT &&
      isRecord(bridged) &&
      typeof bridged.hasImage === "boolean"
    ) {
      return bridged as {
        text?: string;
        html?: string;
        rtf?: string;
        hasImage: boolean;
      };
    }
    return { text: await navigator.clipboard.readText(), hasImage: false };
  }
  async clearClipboard(): Promise<void> {
    if ((await bridgeRequest("clearClipboard")) !== BRIDGE_ABSENT) return;
    await navigator.clipboard.writeText("");
  }

  // Shell
  async openExternal(options: { url: string }): Promise<void> {
    const safeUrl = assertSafeExternalUrl(options.url);
    if (
      (await bridgeRequest("openExternal", { url: safeUrl })) !== BRIDGE_ABSENT
    ) {
      return;
    }
    window.open(safeUrl, "_blank", "noopener");
  }
  async showItemInFolder(options: { path: string }): Promise<void> {
    await bridgeRequest("showItemInFolder", options);
  }

  async beep(): Promise<void> {
    if ((await bridgeRequest("beep")) !== BRIDGE_ABSENT) return;
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

  // Events. On the Electrobun host, desktop events arrive as bridge messages
  // named `desktop` + PascalCase(eventName) (`trayMenuClick` →
  // `desktopTrayMenuClick`); in a plain browser tab only the window
  // focus/blur events have an equivalent.
  async addListener(
    eventName: string,
    listenerFunc: (event: DesktopEventData) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const entry: {
      eventName: string;
      callback: (event: DesktopEventData) => void;
      windowListener?: () => void;
      bridgeListener?: (payload: unknown) => void;
      bridgeMessageName?: string;
    } = { eventName, callback: listenerFunc };

    const rpc = getDesktopRpc();
    if (rpc && typeof rpc.onMessage === "function") {
      entry.bridgeMessageName = `desktop${eventName[0].toUpperCase()}${eventName.slice(1)}`;
      entry.bridgeListener = (payload: unknown) =>
        listenerFunc(payload as DesktopEventData);
      rpc.onMessage(entry.bridgeMessageName, entry.bridgeListener);
    } else if (eventName === "windowFocus") {
      // Create and track window event listeners to avoid memory leaks
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
          this.detachListenerEntry(entry);
          this.pluginListeners.splice(i, 1);
        }
      },
    };
  }

  private detachListenerEntry(entry: {
    eventName: string;
    windowListener?: () => void;
    bridgeListener?: (payload: unknown) => void;
    bridgeMessageName?: string;
  }): void {
    if (entry.bridgeListener && entry.bridgeMessageName) {
      getDesktopRpc()?.offMessage?.(
        entry.bridgeMessageName,
        entry.bridgeListener,
      );
    }
    if (entry.windowListener) {
      if (entry.eventName === "windowFocus")
        window.removeEventListener("focus", entry.windowListener);
      else if (entry.eventName === "windowBlur")
        window.removeEventListener("blur", entry.windowListener);
    }
  }

  async removeAllListeners(): Promise<void> {
    for (const entry of this.pluginListeners) {
      this.detachListenerEntry(entry);
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

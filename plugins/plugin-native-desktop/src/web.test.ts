/**
 * Tests `DesktopWeb`'s Electrobun delegation and browser-fallback contracts —
 * shell startup, tray events, permissions, notifications, window listeners,
 * external URL safety, and battery state — against stubbed globals and RPC,
 * not a real browser or native host.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopWeb } from "./web";

const EXPECTED_TEST_PLATFORM =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  process.platform === "linux"
    ? process.platform
    : "linux";

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function setWindow(value: Partial<Window> & Record<string, unknown>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

describe("DesktopWeb browser fallback contracts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("delegates packaged-shell startup and shortcut operations to Electrobun RPC", async () => {
    const requests = {
      desktopGetVersion: vi.fn(async () => ({
        version: "2.0.3",
        name: "Eliza",
        runtime: "electrobun/1.3.4",
      })),
      desktopRegisterShortcut: vi.fn(async () => ({ success: true })),
      desktopUnregisterShortcut: vi.fn(async () => undefined),
      desktopUnregisterAllShortcuts: vi.fn(async () => undefined),
      desktopIsShortcutRegistered: vi.fn(async () => ({ registered: true })),
      desktopSetTrayMenu: vi.fn(async () => undefined),
      desktopIsWindowFocused: vi.fn(async () => ({ focused: false })),
      desktopIsWindowVisible: vi.fn(async () => ({ visible: true })),
      desktopHideWindow: vi.fn(async () => undefined),
      desktopShowWindow: vi.fn(async () => undefined),
      desktopFocusWindow: vi.fn(async () => undefined),
    };
    const browserFocus = vi.fn();
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: { request: requests },
      focus: browserFocus,
    });

    const plugin = new DesktopWeb();
    const shortcut = {
      id: "chat-overlay",
      accelerator: "Alt+Shift+Super+F11",
    };
    const menu = [{ id: "open", label: "Open Eliza" }];

    await expect(plugin.getVersion()).resolves.toEqual({
      version: "2.0.3",
      name: "Eliza",
      runtime: "electrobun/1.3.4",
      chrome: "N/A",
      node: "N/A",
    });
    await expect(plugin.registerShortcut(shortcut)).resolves.toEqual({
      success: true,
    });
    await expect(
      plugin.isShortcutRegistered({ accelerator: shortcut.accelerator }),
    ).resolves.toEqual({ registered: true });
    await plugin.unregisterShortcut({ id: shortcut.id });
    await plugin.unregisterAllShortcuts();
    await plugin.setTrayMenu({ menu });
    await expect(plugin.isWindowFocused()).resolves.toEqual({ focused: false });
    await expect(plugin.isWindowVisible()).resolves.toEqual({ visible: true });
    await plugin.hideWindow();
    await plugin.showWindow();
    await plugin.focusWindow();

    expect(requests.desktopGetVersion).toHaveBeenCalledOnce();
    expect(requests.desktopRegisterShortcut).toHaveBeenCalledOnce();
    expect(requests.desktopRegisterShortcut).toHaveBeenCalledWith(shortcut);
    expect(requests.desktopIsShortcutRegistered).toHaveBeenCalledWith({
      accelerator: shortcut.accelerator,
    });
    expect(requests.desktopUnregisterShortcut).toHaveBeenCalledWith({
      id: shortcut.id,
    });
    expect(requests.desktopUnregisterAllShortcuts).toHaveBeenCalledOnce();
    expect(requests.desktopSetTrayMenu).toHaveBeenCalledWith({ menu });
    expect(requests.desktopIsWindowFocused).toHaveBeenCalledOnce();
    expect(requests.desktopIsWindowVisible).toHaveBeenCalledOnce();
    expect(requests.desktopHideWindow).toHaveBeenCalledOnce();
    expect(requests.desktopShowWindow).toHaveBeenCalledOnce();
    expect(requests.desktopFocusWindow).toHaveBeenCalledOnce();
    expect(browserFocus).not.toHaveBeenCalled();
  });

  it("preserves unsupported browser results when Electrobun RPC is absent", async () => {
    const focus = vi.fn();
    setWindow({ focus });
    setNavigator({ userAgent: "Mozilla/5.0 Chrome/125.0.0.0" });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { hidden: false, hasFocus: () => true },
    });

    const plugin = new DesktopWeb();
    await expect(
      plugin.registerShortcut({
        id: "chat-overlay",
        accelerator: "Alt+Shift+Super+F11",
      }),
    ).resolves.toEqual({ success: false });
    await expect(
      plugin.isShortcutRegistered({ accelerator: "Alt+Shift+Super+F11" }),
    ).resolves.toEqual({ registered: false });
    await expect(plugin.getVersion()).resolves.toMatchObject({
      runtime: "N/A",
      node: "N/A",
    });
    await expect(plugin.isWindowVisible()).resolves.toEqual({ visible: true });
    await expect(plugin.isWindowFocused()).resolves.toEqual({ focused: true });
    await plugin.hideWindow();
    await plugin.showWindow();
    await plugin.focusWindow();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed desktop bridge permission responses and falls back to browser query", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const permissionsCheck = vi.fn(async () => ({
      id: "camera",
      status: "granted",
      canRequest: true,
    }));
    const query = vi.fn(async (descriptor: PermissionDescriptor) => {
      expect(descriptor.name).toBe("camera");
      return { state: "denied" };
    });
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: { permissionsCheck },
      },
    });
    setNavigator({
      platform: "MacIntel",
      permissions: { query } as unknown as Permissions,
    });

    await expect(
      new DesktopWeb().checkPermission({ id: "camera" }),
    ).resolves.toEqual({
      id: "camera",
      status: "denied",
      lastChecked: 10_000,
      canRequest: false,
      platform: EXPECTED_TEST_PLATFORM,
    });
    expect(permissionsCheck).toHaveBeenCalledWith({ id: "camera" });
  });

  it("uses browser microphone request when bridge leaves a browser permission unresolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const track = { stop: vi.fn() };
    const permissionsRequest = vi.fn(async () => ({
      id: "microphone",
      status: "not-determined",
      lastChecked: 19_000,
      canRequest: true,
      platform: "linux",
    }));
    const query = vi.fn(async (descriptor: PermissionDescriptor) => {
      expect(descriptor.name).toBe("microphone");
      return { state: "granted" };
    });
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
    }));
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: { permissionsRequest },
      },
    });
    setNavigator({
      platform: "Linux x86_64",
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      permissions: { query } as unknown as Permissions,
    });

    await expect(
      new DesktopWeb().requestPermission({
        id: "microphone",
        reason: "record calls",
      }),
    ).resolves.toEqual({
      id: "microphone",
      status: "granted",
      lastChecked: 20_000,
      lastRequested: 20_000,
      canRequest: false,
      platform: EXPECTED_TEST_PLATFORM,
    });
    expect(permissionsRequest).toHaveBeenCalledWith({ id: "microphone" });
    expect(getUserMedia).toHaveBeenCalledWith({ video: false, audio: true });
    expect(track.stop).toHaveBeenCalled();
  });

  it("fires notification click listeners and reports denied/request-failed notification states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    type NotificationMockConstructor = {
      new (
        title: string,
        options?: NotificationOptions,
      ): { onclick?: (() => void) | null };
      permission: NotificationPermission;
      requestPermission: ReturnType<typeof vi.fn>;
    };
    let latestNotification:
      | {
          onclick?: (() => void) | null;
        }
      | undefined;
    const NotificationMock = vi.fn(function Notification(
      this: { onclick?: () => void },
      title: string,
      options: NotificationOptions,
    ) {
      expect(title).toBe("Build complete");
      expect(options).toEqual({
        body: "Ready",
        icon: undefined,
        silent: true,
      });
      latestNotification = this;
    }) as unknown as NotificationMockConstructor;
    NotificationMock.permission = "granted";
    NotificationMock.requestPermission = vi.fn();
    setWindow({ Notification: NotificationMock });
    vi.stubGlobal("Notification", NotificationMock);

    const plugin = new DesktopWeb();
    const clicked = vi.fn();
    await plugin.addListener("notificationClick", clicked);

    await expect(
      plugin.showNotification({
        title: "Build complete",
        body: "Ready",
        silent: true,
      }),
    ).resolves.toEqual({ id: "notification_30000", shown: true });
    (
      latestNotification as { onclick?: (() => void) | null } | undefined
    )?.onclick?.();
    expect(clicked).toHaveBeenCalledWith({});

    NotificationMock.permission = "denied";
    await expect(
      plugin.showNotification({ title: "Blocked" }),
    ).resolves.toEqual({
      id: "notification_30000",
      shown: false,
      error: "Notification permission denied",
    });

    NotificationMock.permission = "default";
    NotificationMock.requestPermission.mockResolvedValueOnce("default");
    await expect(
      plugin.showNotification({ title: "Prompt rejected" }),
    ).resolves.toEqual({
      id: "notification_30000",
      shown: false,
      error: "Notification permission not granted",
    });
  });

  it("cleans browser focus and blur listeners on handle removal and removeAllListeners", async () => {
    const listeners = new Map<string, EventListener[]>();
    const addEventListener = vi.fn(
      (eventName: string, listener: EventListener) => {
        const existing = listeners.get(eventName) ?? [];
        existing.push(listener);
        listeners.set(eventName, existing);
      },
    );
    const removeEventListener = vi.fn(
      (eventName: string, listener: EventListener) => {
        listeners.set(
          eventName,
          (listeners.get(eventName) ?? []).filter(
            (entry) => entry !== listener,
          ),
        );
      },
    );
    setWindow({ addEventListener, removeEventListener });

    const plugin = new DesktopWeb();
    const focused = vi.fn();
    const blurred = vi.fn();
    const focusHandle = await plugin.addListener("windowFocus", focused);
    await plugin.addListener("windowBlur", blurred);

    listeners.get("focus")?.forEach((listener) => {
      listener(new Event("focus"));
    });
    listeners.get("blur")?.forEach((listener) => {
      listener(new Event("blur"));
    });
    expect(focused).toHaveBeenCalledWith(undefined);
    expect(blurred).toHaveBeenCalledWith(undefined);

    await focusHandle.remove();
    expect(listeners.get("focus")).toEqual([]);
    await plugin.removeAllListeners();
    expect(listeners.get("blur")).toEqual([]);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("bridges native tray-menu events and removes the exact registered listener", async () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const onMessage = vi.fn(
      (messageName: string, listener: (payload: unknown) => void) => {
        const registered = listeners.get(messageName) ?? new Set();
        registered.add(listener);
        listeners.set(messageName, registered);
      },
    );
    const offMessage = vi.fn(
      (messageName: string, listener: (payload: unknown) => void) => {
        listeners.get(messageName)?.delete(listener);
      },
    );
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {},
        onMessage,
        offMessage,
      },
    });

    const plugin = new DesktopWeb();
    const first = vi.fn();
    const second = vi.fn();
    const firstHandle = await plugin.addListener("trayMenuClick", first);
    await plugin.addListener("trayMenuClick", second);

    const emit = (payload: unknown) => {
      for (const listener of listeners.get("desktopTrayMenuClick") ?? []) {
        listener(payload);
      }
    };
    emit({ itemId: "tray-open-chat", checked: false });
    expect(first).toHaveBeenCalledWith({
      itemId: "tray-open-chat",
      checked: false,
    });
    expect(second).toHaveBeenCalledOnce();

    emit({ itemId: 7 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    const firstRpcListener = onMessage.mock.calls[0]?.[1];
    await firstHandle.remove();
    expect(offMessage).toHaveBeenCalledWith(
      "desktopTrayMenuClick",
      firstRpcListener,
    );
    emit({ itemId: "tray-open-plugins" });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);

    await plugin.removeAllListeners();
    expect(listeners.get("desktopTrayMenuClick")?.size).toBe(0);
    expect(offMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe external URLs before opening a window", async () => {
    const open = vi.fn();
    setWindow({ open });

    await expect(
      new DesktopWeb().openExternal({ url: "javascript:alert(1)" }),
    ).rejects.toThrow("url protocol is not allowed");
    await expect(
      new DesktopWeb().openExternal({ url: "https://example.com/path" }),
    ).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledWith(
      "https://example.com/path",
      "_blank",
      "noopener",
    );
  });

  it("clamps valid battery levels and ignores malformed battery fields", async () => {
    const getBattery = vi
      .fn()
      .mockResolvedValueOnce({ charging: false, level: 1.5 })
      .mockResolvedValueOnce({ charging: "yes", level: Number.NaN });
    setNavigator({ getBattery } as Partial<Navigator>);

    await expect(new DesktopWeb().getPowerState()).resolves.toMatchObject({
      onBattery: true,
      batteryLevel: 100,
      isCharging: false,
      idleState: "active",
    });
    await expect(new DesktopWeb().getPowerState()).resolves.toMatchObject({
      onBattery: false,
      batteryLevel: undefined,
      isCharging: undefined,
      idleState: "active",
    });
  });
});

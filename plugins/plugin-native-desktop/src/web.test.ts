/**
 * Tests `DesktopWeb`'s browser-fallback contracts — permission bridging,
 * notifications, window focus/blur listeners, external URL safety, and
 * battery state — against a stubbed `window`/`navigator` and mocked
 * Electrobun RPC, not a real browser or native host.
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

describe("DesktopWeb Electrobun bridge proxying", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes tray, shortcut, window, and app calls to the desktop* RPC methods", async () => {
    const calls: Array<[string, unknown]> = [];
    const handler =
      (name: string, result?: unknown) => async (params?: unknown) => {
        calls.push([name, params]);
        return result;
      };
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {
          desktopSetTrayMenu: handler("desktopSetTrayMenu"),
          desktopRegisterShortcut: handler("desktopRegisterShortcut", {
            success: true,
          }),
          desktopShowWindow: handler("desktopShowWindow"),
          desktopIsWindowFocused: handler("desktopIsWindowFocused", {
            focused: true,
          }),
          desktopQuit: handler("desktopQuit"),
          desktopGetVersion: handler("desktopGetVersion", {
            version: "1.2.3",
            name: "Eliza",
            runtime: "electrobun/1.3.13",
          }),
        },
      },
    });

    const desktop = new DesktopWeb();
    const menu = [{ id: "quit", label: "Quit", type: "normal" as const }];
    await desktop.setTrayMenu({ menu });
    await expect(
      desktop.registerShortcut({ id: "chat-overlay", accelerator: "Cmd+E" }),
    ).resolves.toEqual({ success: true });
    await desktop.showWindow();
    await expect(desktop.isWindowFocused()).resolves.toEqual({
      focused: true,
    });
    await desktop.quit();
    await expect(desktop.getVersion()).resolves.toMatchObject({
      version: "1.2.3",
      name: "Eliza",
      runtime: "electrobun/1.3.13",
    });

    expect(calls.map(([name]) => name)).toEqual([
      "desktopSetTrayMenu",
      "desktopRegisterShortcut",
      "desktopShowWindow",
      "desktopIsWindowFocused",
      "desktopQuit",
      "desktopGetVersion",
    ]);
    expect(calls[0][1]).toEqual({ menu });
  });

  it("getVersion reports the browser fallback (runtime N/A) without a bridge", async () => {
    setWindow({});
    setNavigator({ userAgent: "Chrome/120.0.0" } as Partial<Navigator>);
    await expect(new DesktopWeb().getVersion()).resolves.toMatchObject({
      runtime: "N/A",
    });
  });

  it("bridges plugin event listeners onto desktop* bridge messages", async () => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    setWindow({
      __ELIZA_ELECTROBUN_RPC__: {
        request: {},
        onMessage: (name: string, cb: (payload: unknown) => void) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name)?.add(cb);
        },
        offMessage: (name: string, cb: (payload: unknown) => void) => {
          listeners.get(name)?.delete(cb);
        },
      },
    });

    const desktop = new DesktopWeb();
    const seen: unknown[] = [];
    const sub = await desktop.addListener("trayMenuClick", (event) => {
      seen.push(event);
    });

    const emit = listeners.get("desktopTrayMenuClick");
    expect(emit?.size).toBe(1);
    for (const cb of emit ?? []) cb({ itemId: "quit", checked: false });
    expect(seen).toEqual([{ itemId: "quit", checked: false }]);

    await sub.remove();
    expect(listeners.get("desktopTrayMenuClick")?.size).toBe(0);
  });
});

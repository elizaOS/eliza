/**
 * Tests `DesktopWeb`'s browser-fallback contracts — permission bridging,
 * notifications, window focus/blur listeners, external URL safety, fullscreen
 * promise propagation, and battery state — against a stubbed
 * `window`/`navigator`/`document` and mocked Electrobun RPC, not a real browser
 * or native host.
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
  vi.stubGlobal("navigator", value);
}

function setWindow(value: Partial<Window> & Record<string, unknown>): void {
  vi.stubGlobal("window", value);
}

function setDocument(value: Record<string, unknown>): void {
  vi.stubGlobal("document", value);
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
    const events = new EventTarget();
    vi.stubGlobal("window", events);

    const plugin = new DesktopWeb();
    const focused = vi.fn();
    const blurred = vi.fn();
    const focusHandle = await plugin.addListener("windowFocus", focused);
    await plugin.addListener("windowBlur", blurred);

    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("blur"));
    expect(focused).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(blurred).toHaveBeenCalledExactlyOnceWith(undefined);

    await focusHandle.remove();
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("blur"));
    expect(focused).toHaveBeenCalledTimes(1);
    expect(blurred).toHaveBeenCalledTimes(2);

    await plugin.removeAllListeners();
    events.dispatchEvent(new Event("blur"));
    expect(blurred).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe external URLs before opening a window", async () => {
    const open = vi.fn();
    setWindow({ open });

    await expect(
      new DesktopWeb().openExternal({ url: "javascript:alert(1)" }),
    ).rejects.toThrow("url protocol is not allowed");
    expect(open).not.toHaveBeenCalled();
    await expect(
      new DesktopWeb().openExternal({ url: "https://example.com/path" }),
    ).resolves.toBeUndefined();

    expect(open).toHaveBeenCalledWith(
      "https://example.com/path",
      "_blank",
      "noopener",
    );
  });

  it.each([false, true])(
    "propagates the selected fullscreen rejection (flag=%s)",
    async (flag) => {
      const rejection = new TypeError("Fullscreen transition denied");
      const selected = vi.fn(() => Promise.reject(rejection));
      const other = vi.fn(() => Promise.resolve());
      setDocument({
        documentElement: { requestFullscreen: flag ? selected : other },
        exitFullscreen: flag ? other : selected,
      });

      await expect(new DesktopWeb().setFullscreen({ flag })).rejects.toBe(
        rejection,
      );
      expect(selected).toHaveBeenCalledTimes(1);
      expect(other).not.toHaveBeenCalled();
    },
  );

  it("resolves when the underlying fullscreen transition succeeds", async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    const exitFullscreen = vi.fn(() => Promise.resolve());
    setDocument({
      documentElement: { requestFullscreen },
      exitFullscreen,
    });

    const plugin = new DesktopWeb();
    await expect(plugin.setFullscreen({ flag: true })).resolves.toBeUndefined();
    await expect(
      plugin.setFullscreen({ flag: false }),
    ).resolves.toBeUndefined();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
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

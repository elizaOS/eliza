import { afterEach, describe, expect, it, vi } from "vitest";

import { MobileSignalsWeb } from "./web";

function setNavigator(value: Partial<Navigator>): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

function setDocument(value: Partial<Document>): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value,
  });
}

describe("MobileSignalsWeb fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns unavailable permission details without native access", async () => {
    setNavigator({ userAgent: "Mozilla/5.0 (iPhone)" });

    await expect(
      new MobileSignalsWeb().checkPermissions(),
    ).resolves.toMatchObject({
      status: "not-applicable",
      canRequest: false,
      canOpenSettings: false,
      engine: "web-fallback",
      capabilities: {
        health: false,
        screenTime: false,
        notifications: false,
        settings: false,
      },
      screenTime: {
        supported: false,
        authorization: {
          status: "unavailable",
          canRequest: false,
        },
      },
    });
  });

  it("normalizes known settings targets and rejects hostile targets", async () => {
    const plugin = new MobileSignalsWeb();

    await expect(
      plugin.openSettings({ target: "screenTime" }),
    ).resolves.toMatchObject({
      opened: false,
      target: "screenTime",
      actualTarget: "app",
    });
    await expect(
      plugin.openSettings({ target: "__proto__" as never }),
    ).rejects.toThrow("target must be a valid mobile settings target");
  });

  it("builds snapshots from visibility, focus, platform, and clamped battery data", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Linux; Android 15)",
      getBattery: vi.fn(async () => ({ charging: false, level: 1.5 })),
    } as Partial<Navigator>);
    setDocument({
      visibilityState: "visible",
      hasFocus: vi.fn(() => true),
    });

    await expect(new MobileSignalsWeb().getSnapshot()).resolves.toMatchObject({
      supported: true,
      snapshot: {
        source: "mobile_device",
        platform: "android",
        state: "active",
        idleState: "active",
        onBattery: true,
        metadata: {
          batteryLevel: 1,
          isCharging: false,
          visibilityState: "visible",
          hasFocus: true,
        },
      },
      healthSnapshot: {
        source: "mobile_health",
        platform: "android",
        state: "idle",
      },
    });
  });

  it("degrades malformed or rejected battery API results to null metadata", async () => {
    setNavigator({
      userAgent: "Mozilla/5.0",
      getBattery: vi.fn(async () => {
        throw new Error("battery denied");
      }),
    } as Partial<Navigator>);
    setDocument({
      visibilityState: "hidden",
      hasFocus: vi.fn(() => false),
    });

    await expect(new MobileSignalsWeb().getSnapshot()).resolves.toMatchObject({
      snapshot: {
        platform: "web",
        state: "background",
        idleState: "idle",
        onBattery: null,
        metadata: {
          batteryLevel: null,
          isCharging: null,
        },
      },
    });
  });

  it("emits initial signals only when requested", async () => {
    setNavigator({ userAgent: "Mozilla/5.0" });
    setDocument({ visibilityState: "visible", hasFocus: vi.fn(() => true) });

    const plugin = new MobileSignalsWeb();
    const listener = vi.fn();
    await plugin.addListener("signal", listener);

    await plugin.startMonitoring({ emitInitial: false });
    expect(listener).not.toHaveBeenCalled();

    await plugin.startMonitoring({ emitInitial: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
